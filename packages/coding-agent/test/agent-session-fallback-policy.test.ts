import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const PRIMARY = "anthropic/claude-sonnet-4-5";
const FALLBACK = "openai/gpt-4o-mini";
const PRIMARY_WINDOW_MS = 120_000;
const FALLBACK_HOLD_MS = 10_800_000;
const SUMMARY = "Preserved decision: use the fallback while the primary is unavailable.";

function usage(input = 0): AssistantMessage["usage"] {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function usageLimit(retryAfterMs: number): Error {
	return new AIError.ProviderHttpError(
		`429 No Anthropic account can serve this model: all accounts resting; retry-after-ms=${retryAfterMs}`,
		429,
		{ code: "pool_exhausted" },
	);
}

function errorStream(model: Model, error: Error): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({
			type: "error",
			reason: "error",
			error: {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usage(),
				stopReason: "error",
				timestamp: Date.now(),
				errorMessage: error.message,
				errorId: AIError.classify(error),
				errorStatus: AIError.status(error),
			},
		});
	});
	return stream;
}

interface PolicyClock {
	elapsed(): number;
	advance(ms: number): Promise<void>;
}

/** Keep wall time and the existing monotonic fake clock on the same retry schedule. */
function policyClock(): PolicyClock {
	const epoch = Date.now();
	const waits = mockSchedulerWaitWithClock();
	vi.spyOn(Date, "now").mockImplementation(
		() => epoch + waits.mock.calls.reduce((elapsed, [delay]) => elapsed + delay, 0),
	);
	return {
		elapsed: () => Date.now() - epoch,
		advance: async (ms: number) => {
			await scheduler.wait(ms);
		},
	};
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected a terminal assistant message");
	return message;
}

// Agent lifecycle/health scheduler waits add a few milliseconds unrelated to retry policy.
function expectPolicyTime(actual: number, expected: number) {
	expect(actual).toBeGreaterThanOrEqual(expected - 100);
	expect(actual).toBeLessThanOrEqual(expected + 100);
}

describe("AgentSession timed fallback policy", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let clock: PolicyClock;

	beforeAll(async () => {
		await initTheme();
		tempDir = TempDir.createSync("@pi-fallback-policy-");
		// Use bundled identities, but pin the owner's 1M -> 500k window transition.
		await Bun.write(
			path.join(tempDir.path(), "models.json"),
			JSON.stringify({
				providers: {
					anthropic: { modelOverrides: { "claude-sonnet-4-5": { contextWindow: 1_000_000, maxTokens: 4096 } } },
					openai: { modelOverrides: { "gpt-4o-mini": { contextWindow: 500_000, maxTokens: 4096 } } },
				},
			}),
		);
	});

	beforeEach(async () => {
		// A fresh in-memory auth DB prevents one test's usage-limit blocks leaking into another.
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-primary-key");
		authStorage.keys.setRuntime("openai", "test-fallback-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));
		clock = policyClock();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		vi.restoreAllMocks();
	});

	afterAll(() => tempDir.removeSync());

	function createSession(
		failure: (selector: string, attempt: number) => Error | undefined,
		options: { compaction?: "summary" | "cancel" | "no-reduction" | "model-change" } = {},
	) {
		const primary = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Missing primary fixture model");
		const requests: Array<{ selector: string; at: number; context: string }> = [];
		const events: AgentSessionEvent[] = [];
		const preparations: CompactionPreparation[] = [];
		const manager = SessionManager.inMemory();
		const mock = createMockModel();
		const attempts = new Map<string, number>();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (model, context, streamOptions) => {
				const selector = `${model.provider}/${model.id}`;
				requests.push({ selector, at: clock.elapsed(), context: JSON.stringify(context) });
				const attempt = (attempts.get(selector) ?? 0) + 1;
				attempts.set(selector, attempt);
				// Bound a broken retry/compaction loop without making live requests or hanging the test.
				if (requests.length > 20) {
					return errorStream(model, new Error("Test request safety bound exceeded"));
				}
				const error = failure(selector, attempt);
				if (error) return errorStream(model, error);
				mock.push({ content: [`ok:${selector}`] });
				return mock.stream(model, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": options.compaction !== undefined,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 90,
			"compaction.thresholdTokens": -1,
			"compaction.keepRecentTokens": 1,
			"compaction.asyncEnabled": false,
			"contextPromotion.enabled": false,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 30_000,
			"retry.maxDelayMs": 30_000,
			"retry.fallbackAfterMs": PRIMARY_WINDOW_MS,
			"retry.fallbackMinHoldMs": FALLBACK_HOLD_MS,
			"retry.compactForFallback": true,
			"retry.fallbackRevertPolicy": "cooldown-expiry",
			"retry.fallbackChains": { default: [FALLBACK] },
			"retry.usageLimitFallbackChains": { default: [FALLBACK] },
		});
		settings.setModelRole("default", PRIMARY);
		// Only summary generation is mocked. Preparation, persistence, history rebuilding,
		// and the post-compaction fit check run through the production pipeline.
		const extensionRunner = options.compaction
			? {
					hasHandlers: (type: string) => type === "session_before_compact",
					emitBeforeAgentStart: async () => undefined,
					emit: async (event: { type: string; preparation?: CompactionPreparation }) => {
						if (event.type !== "session_before_compact" || !event.preparation) return undefined;
						preparations.push(event.preparation);
						if (options.compaction === "cancel" || preparations.length > 1) return { cancel: true };
						if (options.compaction === "model-change") {
							const chosen = modelRegistry.find("openai", "gpt-4o");
							if (!chosen || !session) throw new Error("Missing explicit-choice fixture");
							await session.setModel(chosen);
						}
						return {
							compaction: {
								summary: options.compaction === "no-reduction" ? "unreduced history ".repeat(160_000) : SUMMARY,
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					},
				}
			: undefined;
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			extensionRunner: extensionRunner as never,
		});
		session.subscribe(event => events.push(event));
		return { session, requests, events, preparations, primary };
	}

	for (const [name, error] of [
		["usage limit", usageLimit(30_000)],
		["retryable 429", new AIError.ProviderHttpError("429 temporarily busy; retry-after-ms=30000", 429)],
		["503", new AIError.ProviderHttpError("503 Service Unavailable; retry-after-ms=30000", 503)],
		["529", new AIError.ProviderHttpError("529 overloaded_error; retry-after-ms=30000", 529)],
	] as const) {
		it(`keeps retrying ${name} for 120s despite maxRetries=1`, async () => {
			const h = createSession(selector => (selector === PRIMARY ? error : undefined));
			await h.session.prompt("Recover on the configured fallback");
			await h.session.waitForIdle();
			const primaryRequests = h.requests.filter(request => request.selector === PRIMARY);
			const fallbackRequests = h.requests.filter(request => request.selector === FALLBACK);
			expect(primaryRequests.length).toBeGreaterThan(2);
			expect(primaryRequests[0].at).toBeLessThanOrEqual(100);
			expect(primaryRequests.every(request => request.at <= PRIMARY_WINDOW_MS + 100)).toBe(true);
			for (let i = 1; i < primaryRequests.length; i++) {
				expect(primaryRequests[i].at - primaryRequests[i - 1].at).toBeGreaterThanOrEqual(30_000);
			}
			expect(fallbackRequests).toHaveLength(1);
			expectPolicyTime(fallbackRequests[0].at - primaryRequests[0].at, PRIMARY_WINDOW_MS);
			expect(h.events.filter(event => event.type === "retry_fallback_applied")).toHaveLength(1);
			expect(lastAssistant(h.session).content).toEqual([{ type: "text", text: `ok:${FALLBACK}` }]);
		});
	}

	it("keeps the primary when it recovers inside the retry window", async () => {
		const h = createSession((selector, attempt) =>
			selector === PRIMARY && attempt <= 2 ? usageLimit(30_000) : undefined,
		);
		await h.session.prompt("Recover before the primary window expires");
		await h.session.waitForIdle();
		expect(h.requests.map(request => request.selector)).toEqual([PRIMARY, PRIMARY, PRIMARY]);
		for (let i = 1; i < h.requests.length; i++) {
			const delay = h.requests[i].at - h.requests[i - 1].at;
			expect(delay).toBeGreaterThanOrEqual(30_000);
			expectPolicyTime(delay, 30_000);
		}
		expect(h.events.filter(event => event.type === "retry_fallback_applied")).toHaveLength(0);
		expect(lastAssistant(h.session).stopReason).toBe("stop");
	});

	it("retries after the failed assistant tail is rebuilt during the primary wait", async () => {
		const h = createSession((selector, attempt) =>
			selector === PRIMARY && attempt === 1 ? usageLimit(30_000) : undefined,
		);
		let rebuilt = false;
		h.session.subscribe(event => {
			if (event.type !== "auto_retry_start" || rebuilt) return;
			const messages = h.session.agent.state.messages;
			const failed = messages.at(-1);
			if (failed?.role !== "assistant" || failed.stopReason !== "error") return;
			const replacement = structuredClone(failed);
			expect(replacement).not.toBe(failed);
			h.session.agent.replaceMessages(messages.map(message => (message === failed ? replacement : message)));
			rebuilt = true;
		});
		await h.session.prompt("Continue after history rebuilds during the retry delay");
		await h.session.waitForIdle();
		expect(rebuilt).toBe(true);
		expect(h.requests.map(request => request.selector)).toEqual([PRIMARY, PRIMARY]);
		const delay = h.requests[1].at - h.requests[0].at;
		expect(delay).toBeGreaterThanOrEqual(30_000);
		expectPolicyTime(delay, 30_000);
		expect(lastAssistant(h.session).stopReason).toBe("stop");
		expect(h.session.messages.some(message => message.role === "assistant" && message.stopReason === "error")).toBe(
			false,
		);
		expect(h.events.filter(event => event.type === "retry_fallback_applied")).toHaveLength(0);
	});

	it("switches at 120s on Retry-After 240s without sending an early primary request", async () => {
		const h = createSession(selector => (selector === PRIMARY ? usageLimit(240_000) : undefined));
		await h.session.prompt("Respect the server's Retry-After");
		await h.session.waitForIdle();
		expect(h.requests.map(request => request.selector)).toEqual([PRIMARY, FALLBACK]);
		expectPolicyTime(h.requests[1].at - h.requests[0].at, PRIMARY_WINDOW_MS);
		expectPolicyTime(clock.elapsed() - h.requests[0].at, PRIMARY_WINDOW_MS);
		expect(lastAssistant(h.session).stopReason).toBe("stop");
	});

	it("holds fallback for three hours from the switch, then lazily restores the primary", async () => {
		const h = createSession((selector, attempt) =>
			selector === PRIMARY && attempt === 1 ? usageLimit(240_000) : undefined,
		);
		await h.session.prompt("Switch to fallback");
		await h.session.waitForIdle();
		const switchedAt = h.requests.at(-1)!.at;
		expect(h.requests.at(-1)?.selector).toBe(FALLBACK);
		await clock.advance(300_000);
		await h.session.prompt("The primary's server cooldown has expired, but the minimum hold has not");
		await h.session.waitForIdle();
		expect(h.requests.at(-1)?.selector).toBe(FALLBACK);
		await clock.advance(switchedAt + FALLBACK_HOLD_MS - 100 - clock.elapsed());
		await h.session.prompt("Just before the hold expires");
		await h.session.waitForIdle();
		expect(h.requests.at(-1)?.selector).toBe(FALLBACK);
		await clock.advance(200);
		await h.session.prompt("The hold has now expired");
		await h.session.waitForIdle();
		expect(h.requests.map(request => request.selector)).toEqual([PRIMARY, FALLBACK, FALLBACK, FALLBACK, PRIMARY]);
		expectPolicyTime(h.requests.at(-1)!.at - switchedAt, FALLBACK_HOLD_MS + 100);
		expect(lastAssistant(h.session).stopReason).toBe("stop");
	});

	it("does not re-request a usage-blocked fallback on subsequent user turns", async () => {
		const fallbackError = usageLimit(86_400_000);
		const h = createSession(selector => (selector === PRIMARY ? usageLimit(240_000) : fallbackError));
		await h.session.prompt("Both permitted providers are unavailable");
		await h.session.waitForIdle();
		expect(h.requests.map(request => request.selector)).toEqual([PRIMARY, FALLBACK]);
		expect(lastAssistant(h.session).errorMessage).toBe(fallbackError.message);
		const requestCount = h.requests.length;
		for (const prompt of ["Try again immediately", "Do not bypass the fallback usage block"]) {
			// A preflight rejection may throw rather than append a new assistant error.
			await h.session.prompt(prompt).catch(error => {
				expect(String(error)).toContain(fallbackError.message);
			});
			await h.session.waitForIdle();
			expect(h.requests).toHaveLength(requestCount);
		}
	});

	function seedOversizedHistory(target: AgentSession, primary: Model) {
		const manager = target.sessionManager;
		manager.appendMessage({ role: "user", content: "old bulky context ".repeat(140_000), timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "The old work is complete." }],
			api: primary.api,
			provider: primary.provider,
			model: primary.id,
			usage: usage(630_000),
			stopReason: "stop",
			timestamp: Date.now(),
		});
		manager.appendMessage({ role: "user", content: "Retain the latest task decision.", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Latest decision acknowledged." }],
			api: primary.api,
			provider: primary.provider,
			model: primary.id,
			usage: usage(630_000),
			stopReason: "stop",
			timestamp: Date.now(),
		});
		target.agent.replaceMessages(target.buildDisplaySessionContext().messages);
	}

	it("compacts >500k history through the real pipeline before requesting the 500k fallback", async () => {
		const h = createSession(selector => (selector === PRIMARY ? usageLimit(240_000) : undefined), {
			compaction: "summary",
		});
		seedOversizedHistory(h.session, h.primary);
		await h.session.prompt("Continue the retained task after fallback compaction");
		await h.session.waitForIdle();
		expect(h.preparations).toHaveLength(1);
		expect(h.preparations[0].tokensBefore).toBeGreaterThan(500_000);
		expect(h.requests.map(request => request.selector)).toEqual([PRIMARY, FALLBACK]);
		expect(h.requests[0].context).toContain("old bulky context");
		expect(h.requests[1].context).toContain(SUMMARY);
		expect(h.requests[1].context).toContain("Continue the retained task after fallback compaction");
		expect(h.requests[1].context).not.toContain("old bulky context");
		expect(h.requests[1].context.length).toBeLessThan(20_000);
		expect(h.session.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(h.session.messages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(lastAssistant(h.session).stopReason).toBe("stop");
	});

	it("does not overwrite an explicit model change or replay stale work after compaction", async () => {
		const h = createSession(selector => (selector === PRIMARY ? usageLimit(240_000) : undefined), {
			compaction: "model-change",
		});
		seedOversizedHistory(h.session, h.primary);
		await h.session.prompt("The user changes models while compaction is in progress");
		await h.session.waitForIdle();
		expect(h.preparations).toHaveLength(1);
		expect(h.session.model?.provider).toBe("openai");
		expect(h.session.model?.id).toBe("gpt-4o");
		expect(h.requests.map(request => request.selector)).toEqual([PRIMARY]);
		await h.session.waitForIdle();
		expect(h.requests).toHaveLength(1);
		expect(h.events.filter(event => event.type === "retry_fallback_succeeded")).toHaveLength(0);
	});

	for (const compaction of ["cancel", "no-reduction"] as const) {
		it(`preserves the original error and stops without replay when compaction returns ${compaction}`, async () => {
			const originalError = usageLimit(240_000);
			const h = createSession(selector => (selector === PRIMARY ? originalError : undefined), { compaction });
			seedOversizedHistory(h.session, h.primary);
			await h.session.prompt("Do not send oversized history to another provider");
			await h.session.waitForIdle();
			expect(h.preparations).toHaveLength(1);
			expect(h.requests.map(request => request.selector)).toEqual([PRIMARY]);
			expect(lastAssistant(h.session).stopReason).toBe("error");
			expect(lastAssistant(h.session).errorMessage).toBe(originalError.message);
			expectPolicyTime(clock.elapsed() - h.requests[0].at, PRIMARY_WINDOW_MS);
			// A second idle barrier must not reveal an auto-continue scheduled by compaction.
			await h.session.waitForIdle();
			expect(h.requests).toHaveLength(1);
			expect(h.preparations).toHaveLength(1);
			expect(h.events.filter(event => event.type === "retry_fallback_succeeded")).toHaveLength(0);
		});
	}
});
