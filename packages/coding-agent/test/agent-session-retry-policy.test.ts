import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type ModelUsageHealth,
	type ProviderSessionState,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

import { cfgRetryUsageReservePolicy } from "@oh-my-pi/pi-coding-agent/session/settings";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

function trackRetryEvents(session: AgentSession): {
	retryStartEvents: AutoRetryStartEvent[];
	retryEndEvents: AutoRetryEndEvent[];
} {
	const retryStartEvents: AutoRetryStartEvent[] = [];
	const retryEndEvents: AutoRetryEndEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") {
			retryStartEvents.push(event);
		}
		if (event.type === "auto_retry_end") {
			retryEndEvents.push(event);
		}
	});
	return { retryStartEvents, retryEndEvents };
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage {
	const lastMessage = session.messages.at(-1);
	if (lastMessage?.role !== "assistant") {
		throw new Error("Expected final assistant message");
	}
	return lastMessage;
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A stream that terminates with a `ThinkingLoop`-flagged error, exactly as the
 *  loop guard aborts a repetitive reasoning stream (issue #8760). */
function thinkingLoopErrorStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage:
				"Thinking loop detected: the model repeated near-identical content (4 near-identical segments within the last 16). Treating as a stream stall and retrying.",
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: partial });
	});
	return stream;
}

/** A stream that completes normally with a single text block. */
function recoveredTextStream(model: Model<Api>, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
		stream.push({ type: "done", reason: "stop", message: partial });
	});
	return stream;
}
function transportErrorAfterToolCallStream(
	model: Model<Api>,
	toolCall: ToolCall,
	thinkingSignature?: string,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const thinking =
			thinkingSignature === undefined
				? undefined
				: {
						type: "thinking" as const,
						thinking: "Signed reasoning before the tool call.",
						thinkingSignature,
					};
		if (thinking) partial.content.push(thinking);
		const toolCallIndex = partial.content.length;
		partial.content.push(toolCall);
		stream.push({ type: "start", partial });
		if (thinking) {
			stream.push({ type: "thinking_start", contentIndex: 0, partial });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking.thinking, partial });
			stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
		}
		stream.push({ type: "toolcall_start", contentIndex: toolCallIndex, partial });
		stream.push({
			type: "toolcall_delta",
			contentIndex: toolCallIndex,
			delta: JSON.stringify(toolCall.arguments),
			partial,
		});
		stream.push({ type: "toolcall_end", contentIndex: toolCallIndex, toolCall, partial });
		stream.push({
			type: "error",
			reason: "error",
			error: {
				...partial,
				stopReason: "error",
				errorMessage: "The socket connection was closed unexpectedly.",
				duration: 1000,
			},
		});
	});
	return stream;
}

function poolExhaustedStream(model: Model<Api>, error: Error): AssistantMessageEventStream {
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
				usage: emptyUsage(),
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

describe("AgentSession same-model retry policy", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	// The model registry is an immutable fixture whose construction builds a
	// canonical index over ~2.7k bundled models (~100ms). Build it (and the
	// auth DB) once for the whole file instead of per-test.
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-policy-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		authStorage.keys.setRuntime("fireworks", "fireworks-test-key");
		authStorage.keys.setRuntime("google", "google-test-key");
		authStorage.keys.setRuntime("google-vertex", "google-vertex-test-key");
		authStorage.keys.setRuntime("openrouter", "openrouter-test-key");
		authStorage.keys.setRuntime("devin", "devin-test-key");
		authStorage.keys.setRuntime("openai-codex", "openai-codex-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	for (const failures of [1, 2]) {
		it(`retries short busy hints once on the same model (${failures} failures)`, async () => {
			const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
			const requested: string[] = [];
			const primarySelector = `${primary.provider}/${primary.id}`;
			const mock = createMockModel();
			mockSchedulerWaitWithClock();
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					requested.push(`${model.provider}/${model.id}`);
					mock.push(
						requested.length <= failures
							? { throw: "429 SpriliCred busy: upstream capacity is briefly saturated; retry-after-ms=1000" }
							: { content: ["recovered"] },
					);
					return mock.stream(model, context, options);
				},
			});
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 2000,
			});
			settings.setModelRole("default", primarySelector);
			session = new AgentSession({ agent, settings, modelRegistry, sessionManager: SessionManager.inMemory() });
			const { retryStartEvents } = trackRetryEvents(session);
			await session.prompt("Answer after the brief busy interval");
			await session.waitForIdle();
			expect(requested).toEqual(
				failures === 1 ? [primarySelector, primarySelector] : [primarySelector, primarySelector, primarySelector],
			);
			expect(retryStartEvents[0].delayMs).toBe(1000);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "model_change")).toHaveLength(0);
			expect(getLastAssistantMessage(session).content).toEqual([{ type: "text", text: "recovered" }]);
		});
	}

	it("continues on the same model when every pooled account is inside reserve", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled reserve model");
		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["continued with full context"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePct": 10,
			"retry.usageReservePolicy": "continue",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage.health, "model").mockImplementation(async provider =>
			provider === primaryModel.provider
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.08,
							},
							{
								credentialId: 2,
								credentialType: "oauth",
								selected: true,
								state: "reserve",
								remainingFraction: 0.02,
							},
						],
					}
				: { state: "healthy", accounts: [] },
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		await session.prompt("Keep working on the same task");
		await session.waitForIdle();
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
		expect(session.messages.some(message => message.role === "user")).toBe(true);
	});

	it("honors a live fail-closed policy after reserve spending was approved", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled reserve policy model");
		const mock = createMockModel({ responses: [{ content: ["stayed on primary"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "continue",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi.spyOn(modelRegistry.authStorage.health, "model").mockImplementation(async provider =>
			provider === primaryModel.provider
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: { state: "healthy", accounts: [] },
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Stay on the primary");
		await session.waitForIdle();
		cfgRetryUsageReservePolicy.override(settings, "fail-closed");
		expect(cfgRetryUsageReservePolicy.get(settings)).toBe("fail-closed");

		await expect(session.prompt("Do not spend reserve")).rejects.toThrow("reserve policy is fail-closed");
		expect(usageHealth).toHaveBeenCalledTimes(2);
	});

	it("releases a quota-blocked session credential when a healthy sibling account exists", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled pooled model");
		const requestedModels: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["same provider continued"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		vi.spyOn(modelRegistry.authStorage.health, "model").mockResolvedValue({
			state: "healthy",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					selected: true,
					state: "reserve",
					remainingFraction: 0.05,
				},
				{ credentialId: 2, credentialType: "oauth", state: "healthy", remainingFraction: 0.8 },
			],
		});
		const release = vi.spyOn(modelRegistry.authStorage.sessions, "release").mockReturnValue(true);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		await session.prompt("Stay on this provider");
		await session.waitForIdle();
		expect(release).toHaveBeenCalledWith(primaryModel.provider, session.sessionId);
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
	});

	it("does not dispatch a prompt after its usage preflight is cancelled", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled preflight model");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
		});
		const probeStarted = Promise.withResolvers<void>();
		vi.spyOn(modelRegistry.authStorage.health, "model").mockImplementation(async (_provider, options) => {
			probeStarted.resolve();
			const aborted = Promise.withResolvers<ModelUsageHealth>();
			options.signal?.addEventListener(
				"abort",
				() => aborted.reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")),
				{ once: true },
			);
			return aborted.promise;
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const prompt = session.prompt("Do not send this after cancellation");
		await probeStarted.promise;
		await session.abort();
		await prompt;

		expect(requestedModels).toEqual([]);
	});

	it("does not reschedule a queued drain after a dequeue hook rejects", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled queued-drain model");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const hookRan = Promise.withResolvers<void>();
		let attempts = 0;
		const failingHook = vi.fn(() => {
			hookRan.resolve();
			if (++attempts === 1) throw new Error("blocked before dequeue");
		});
		agent.addBeforeQueuedMessageDequeueHook(failingHook);

		await session.sendUserMessage("Keep this queued", { deliverAs: "steer" });
		await hookRan.promise;
		await session.waitForIdle();

		expect(failingHook).toHaveBeenCalledTimes(1);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(requestedModels).toEqual([]);
	});

	it("enforces fail-closed usage health", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled fail-closed model");
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel().stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		vi.spyOn(modelRegistry.authStorage.health, "model").mockResolvedValue({
			state: "reserve",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					state: "reserve",
					remainingFraction: 0.05,
				},
			],
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await expect(session.prompt("Do not spend reserve")).rejects.toThrow("reserve policy is fail-closed");
	});

	it("rechecks fail-closed usage health before an internally scheduled continuation", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled scheduled continuation model");
		const requestedModels: string[] = [];
		let useReserve = false;
		const mock = createMockModel({
			responses: [
				async () => {
					useReserve = true;
					return { content: [], stopReason: "stop" };
				},
				{ content: ["must not run"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi.spyOn(modelRegistry.authStorage.health, "model").mockImplementation(async () =>
			useReserve
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: {
						state: "healthy",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "healthy",
								remainingFraction: 0.8,
							},
						],
					},
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Retry this empty response");
		await session.waitForIdle();

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
	});

	it("rechecks fail-closed usage health before a same-turn tool continuation", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled tool-continuation model");
		const requestedModels: string[] = [];
		let useReserve = false;
		const toolSchema = type({ value: type("string") });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "consume",
			label: "Consume",
			description: "Consume plan quota",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				useReserve = true;
				return { content: [{ type: "text", text: params.value }], details: params };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "consume", arguments: { value: "done" } }] },
				{ content: ["must not run"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi.spyOn(modelRegistry.authStorage.health, "model").mockImplementation(async () =>
			useReserve
				? {
						state: "reserve",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "reserve",
								remainingFraction: 0.05,
							},
						],
					}
				: {
						state: "healthy",
						accounts: [
							{
								credentialId: 1,
								credentialType: "oauth",
								state: "healthy",
								remainingFraction: 0.8,
							},
						],
					},
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Use the tool");
		await session.waitForIdle();

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
	});

	it("rechecks fail-closed usage health when prompt setup changes the model", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const setupTarget = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!primaryModel || !setupTarget) throw new Error("Expected bundled setup-handoff models");
		const requestedModels: string[] = [];
		const usageChecks: string[] = [];
		const mock = createMockModel({ responses: [{ content: ["must not run"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi
			.spyOn(modelRegistry.authStorage.health, "model")
			.mockImplementation(async (_provider, options) => {
				usageChecks.push(options.modelId ?? "");
				const reserve = options.modelId === setupTarget.id;
				return {
					state: reserve ? "reserve" : "healthy",
					accounts: [
						{
							credentialId: 1,
							credentialType: "oauth",
							state: reserve ? "reserve" : "healthy",
							remainingFraction: reserve ? 0.05 : 0.8,
						},
					],
				};
			});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn().mockReturnValue(false),
			emitBeforeAgentStart: vi.fn(async () => {
				if (!session) throw new Error("Expected active session");
				await session.setModelTemporary(setupTarget, undefined, { ephemeral: true });
				return undefined;
			}),
		} as unknown as ExtensionRunner;
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Change models during setup");

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(usageChecks).toEqual([primaryModel.id, setupTarget.id]);
		expect(requestedModels).toEqual([]);
	});

	it("restarts usage preflight when the model changes during a health request", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const selectedModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!primaryModel || !selectedModel) throw new Error("Expected bundled preflight race models");
		const requestedModels: string[] = [];
		const usageChecks: string[] = [];
		const healthStarted = Promise.withResolvers<void>();
		const releaseHealth = Promise.withResolvers<void>();
		const mock = createMockModel({ responses: [{ content: ["must not run"] }] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "fail-closed",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		const usageHealth = vi
			.spyOn(modelRegistry.authStorage.health, "model")
			.mockImplementation(async (_provider, options) => {
				usageChecks.push(options.modelId ?? "");
				if (options.modelId === primaryModel.id) {
					healthStarted.resolve();
					await releaseHealth.promise;
				}
				const reserve = options.modelId === selectedModel.id;
				return {
					state: reserve ? "reserve" : "healthy",
					accounts: [
						{
							credentialId: 1,
							credentialType: "oauth",
							state: reserve ? "reserve" : "healthy",
							remainingFraction: reserve ? 0.05 : 0.8,
						},
					],
				};
			});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const prompting = session.prompt("Change models during preflight");
		await healthStarted.promise;
		await session.setModelTemporary(selectedModel, undefined, { ephemeral: true });
		releaseHealth.resolve();
		await expect(prompting).rejects.toThrow(`reserve reached for ${selectedModel.provider}/${selectedModel.id}`);

		expect(usageHealth).toHaveBeenCalledTimes(2);
		expect(usageChecks).toEqual([primaryModel.id, selectedModel.id]);
		expect(session.model?.id).toBe(selectedModel.id);
		expect(requestedModels).toEqual([]);
	});

	it("finishes usage preflight when no model is selected", async () => {
		const agent = new Agent({
			initialState: { model: undefined, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await expect(session.prompt("No model configured")).rejects.toThrow("No model selected");
		expect(agent.state.isStreaming).toBe(false);
	});

	it("rotates sibling credentials on 402 Payment is required and status-only 402", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o") ?? getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test models to exist");
		}

		// The mock model reduces a thrown error to its message text (a `status`
		// property never reaches the AssistantMessage), so carry the 402 inside
		// the message: the first iteration exercises the quota-worded body, the
		// second an opaque status-only body.
		for (const errorToThrow of [new Error("HTTP 402 Payment is required"), new Error("HTTP 402")]) {
			const requestedCalls: Array<{ model: string; apiKey: string | undefined }> = [];
			let currentKey = "key-A";
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: () => currentKey,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
					requestedCalls.push({ model: `${model.provider}/${model.id}`, apiKey });
					if (requestedCalls.length === 1) {
						mock.push({ throw: errorToThrow });
					} else {
						mock.push({ content: ["ok:sibling-credential-success"] });
					}
					return mock.stream(model, context, options);
				},
			});

			// `vi.spyOn` on an already-spied method returns the existing spy with
			// its accumulated call history, so clear it between the parameterized
			// iterations — each must observe exactly one credential rotation.
			const markUsageLimitSpy = vi
				.spyOn(modelRegistry.authStorage.limits, "markReached")
				.mockClear()
				.mockImplementation(async () => {
					currentKey = "key-B";
					return { switched: true };
				});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 2,
			});

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			await session.prompt("Prompt requiring credential rotation");
			await session.waitForIdle();

			expect(markUsageLimitSpy).toHaveBeenCalledTimes(1);
			expect(requestedCalls).toHaveLength(2);
			expect(requestedCalls[0]).toEqual({
				model: `${primaryModel.provider}/${primaryModel.id}`,
				apiKey: "key-A",
			});
			expect(requestedCalls[1]).toEqual({
				model: `${primaryModel.provider}/${primaryModel.id}`,
				apiKey: "key-B",
			});
			expect(session.model?.provider).toBe(primaryModel.provider);
			expect(session.model?.id).toBe(primaryModel.id);
			await session.dispose();
			session = undefined;
		}
	});

	it("surfaces immutable Anthropic thinking errors without retry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled Anthropic test model");

		const immutableThinkingError =
			"400 invalid_request_error: messages.1.content.5: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified";
		const mock = createMockModel();
		const requestedModels: string[] = [];
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					mock.push({
						content: [
							{ type: "thinking", thinking: "Signed Sonnet reasoning.", thinkingSignature: "sonnet-signature" },
							"Seeded turn",
						],
					});
				} else {
					mock.push({ throw: immutableThinkingError });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents } = trackRetryEvents(session);

		await session.prompt("Seed signed thinking");
		await session.waitForIdle();
		await session.prompt("Continue");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(retryStartEvents).toEqual([]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session)).toMatchObject({
			stopReason: "error",
			errorMessage: immutableThinkingError,
		});
	});

	it("keeps signed Anthropic thinking on its source model during transient retry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled Anthropic test model");

		const mock = createMockModel();
		const requestedModels: string[] = [];
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					mock.push({
						content: [
							{ type: "thinking", thinking: "Signed Sonnet reasoning.", thinkingSignature: "sonnet-signature" },
							"Seeded turn",
						],
					});
				} else if (requestCount === 2) {
					mock.push({ throw: "503 overloaded_error: provider returned error" });
				} else {
					mock.push({ content: ["Recovered on Sonnet"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Seed signed thinking");
		await session.waitForIdle();
		const seededAssistant = agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		if (!seededAssistant) throw new Error("Expected seeded assistant message");
		seededAssistant.api = primaryModel.api;
		seededAssistant.provider = primaryModel.provider;
		seededAssistant.model = primaryModel.id;
		await session.prompt("Retry a transient failure");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	it("keeps signed thinking in a preserved transport-error turn on its source Anthropic model", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled Anthropic test model");

		const requestedModels: string[] = [];
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "signed-transport-call",
			name: "bash",
			arguments: { command: "ssh host" },
		};
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					return transportErrorAfterToolCallStream(model, toolCall, "sonnet-signature");
				}
				const mock = createMockModel({ id: model.id, provider: model.provider });
				mock.push({ content: ["Recovered on Sonnet"] });
				return mock.stream(mock, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Run a signed tool turn");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	it("drops classifier refusal messages before later prompts", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					content: ["Classifier declined this turn."],
					stopReason: "error",
					stopDetails: {
						type: "refusal",
						category: "bio",
						explanation: "Classifier declined this turn.",
					},
					errorMessage: "Refusal (bio): Classifier declined this turn.",
				},
				context => {
					const replayedAssistantText = context.messages
						.filter((message): message is AssistantMessage => message.role === "assistant")
						.flatMap(message => message.content)
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
					return {
						content: [replayedAssistantText.includes("Classifier declined this turn.") ? "polluted" : "clean"],
					};
				},
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		const sessionStopCalls: number[] = [];
		const sessionStopLastAssistantMessages: Array<AssistantMessage | undefined> = [];
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn((event: { last_assistant_message?: AssistantMessage }) => {
				sessionStopCalls.push(mock.calls.length);
				sessionStopLastAssistantMessages.push(event.last_assistant_message);
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Trigger classifier refusal");
		await session.waitForIdle();
		await session.prompt("Next prompt should not replay the refusal");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const replayedAssistantText = mock.calls[1]?.context.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(replayedAssistantText).not.toContain("Classifier declined this turn.");
		expect(getLastAssistantMessage(session).content).toEqual([{ type: "text", text: "clean" }]);
		// session_stop hooks must fire after each settled turn — including the
		// refusal turn (regression: prior to PR #3594's review fix, the refusal
		// branch short-circuited before `#emitSessionStopEvent`).
		expect(sessionStopCalls).toEqual([1, 2]);
		expect(sessionStopLastAssistantMessages[0]?.stopReason).toBe("error");
		expect(sessionStopLastAssistantMessages[0]?.stopDetails).toEqual({
			type: "refusal",
			category: "bio",
			explanation: "Classifier declined this turn.",
		});
	});

	it("keeps the pruned refusal visible to getLastAssistantMessage until the next run", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					stopReason: "error",
					stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
					errorMessage: "Refusal (cyber): Declined.",
				},
				{ content: ["recovered"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Trigger classifier refusal");
		await session.waitForIdle();

		// The refusal turn is pruned from active context (no assistant tail)…
		expect(session.agent.state.messages.at(-1)?.role).toBe("user");
		// …but terminal-outcome consumers (print mode, task executor) must still
		// see the settled error instead of a silently successful-looking state.
		const settled = session.getLastAssistantMessage();
		expect(settled?.stopReason).toBe("error");
		expect(settled?.errorMessage).toBe("Refusal (cyber): Declined.");
		expect(settled?.stopDetails).toEqual({ type: "refusal", category: "cyber", explanation: "Declined." });

		await session.prompt("Next prompt supersedes the pruned refusal");
		await session.waitForIdle();

		const recovered = session.getLastAssistantMessage();
		expect(recovered?.stopReason).toBe("stop");
		expect(recovered?.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("uses Google retry hints in quota errors before quota backoff", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const errorMessage =
			"Google API error (429): Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000. Please retry in 0.05s.";
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ throw: errorMessage }, { content: ["Recovered after Google quota retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Google token quota");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 50,
			errorMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Google quota retry" });
	});

	it("keeps retry on the primary model", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled test model");

		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ throw: "rate limit exceeded retry-after-ms=200" }, { content: ["Recovered on primary retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry rate limit without switching models");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 200,
			errorMessage: "rate limit exceeded retry-after-ms=200",
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered on primary retry" });
	});

	it("auto-retries preserved OpenAI first-event timeout errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const timeoutMessage = "OpenAI responses stream timed out while waiting for the first event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: timeoutMessage }, { content: ["Recovered after OpenAI timeout"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry preserved OpenAI timeout");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: timeoutMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after OpenAI timeout" });
	});

	it("auto-retries stream stall errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const stallMessage = "Provider stream stalled while waiting for the next event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: stallMessage }, { content: ["Recovered after stream stall"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stream stall");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: stallMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after stream stall" });
	});

	it("auto-retries OpenAI processing-request transient errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const processingError =
			"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 4a4c6b73-a07c-4de0-aaaf-82560f9f626a in your message.";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: processingError }, { content: ["Recovered after OpenAI processing error"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry OpenAI processing-request error");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: processingError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after OpenAI processing error",
		});
	});

	it("restarts Responses provider state before retrying stale item-id replay errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled test model");

		const staleReplayError = "Item with id 'rs_stale' not found.";
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ throw: staleReplayError }, { content: ["Recovered after Responses state reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", {
			close: closeSpy,
		} satisfies ProviderSessionState);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stale OpenAI replay");
		await session.waitForIdle();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-responses:openai")).toBe(false);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			delayMs: 0,
			errorMessage: staleReplayError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after Responses state reset",
		});
	});

	it("restarts Responses provider state before retrying Zero Data Retention errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled test model");

		// Mirrors the live wire error from OpenAI ZDR orgs after the in-provider
		// retry has already exhausted itself; the higher-level retry must still
		// classify the failure as a stale-replay event so the session reset and
		// zero-delay backoff fire.
		const zdrReplayError = "400 Previous response cannot be used for this organization due to Zero Data Retention.";
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ throw: zdrReplayError }, { content: ["Recovered after ZDR reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", {
			close: closeSpy,
		} satisfies ProviderSessionState);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry ZDR replay");
		await session.waitForIdle();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-responses:openai")).toBe(false);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			delayMs: 0,
			errorMessage: zdrReplayError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after ZDR reset" });
	});

	it("auto-retries Anthropic stream-envelope failures before message_stop", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const envelopeError = "Anthropic stream envelope error: stream ended before message_stop";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: envelopeError }, { content: ["Recovered after Anthropic envelope retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Anthropic envelope failure before message_stop");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: envelopeError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Anthropic envelope retry" });
	});

	it("closes the retry lifecycle when a retried turn ends with a non-retryable error", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled OpenAI test model to exist");

		const retryableError = "rate limit exceeded retry-after-ms=5";
		const terminalError = "invalid request: schema violation";
		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				mock.push({ throw: requestedModels.length === 1 ? retryableError : terminalError });
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		mockSchedulerWaitWithClock();

		await session.prompt("Retry once, then surface a terminal validation failure");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([
			expect.objectContaining({ success: false, attempt: 1, finalError: terminalError }),
		]);
		expect(session.retryAttempt).toBe(0);
		expect(getLastAssistantMessage(session).stopReason).toBe("error");
	});

	it.each(["Request was aborted.", "The operation was aborted", "The operation was aborted."])(
		"auto-retries empty abort errors: %s",
		async abortMessage => {
			const model = getBundledModel("openai", "gpt-4o-mini");
			if (!model) {
				throw new Error("Expected bundled OpenAI test model to exist");
			}

			const requestedModels: string[] = [];
			// A stalled/dropped stream that the provider surfaces as stopReason:"error"
			// carrying the bare abort sentinel, then a clean recovery on the retry.
			const mock = createMockModel({
				responses: [{ throw: abortMessage }, { content: ["recovered after bare abort error"] }],
			});
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					return mock.stream(requestedModel, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxRetries": 1,
			});
			settings.setModelRole("default", `${model.provider}/${model.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});
			mockSchedulerWaitWithClock();
			const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

			await session.prompt("Retry the bare abort error");
			await session.waitForIdle();

			// Same model, retried once.
			expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
			expect(retryStartEvents).toHaveLength(1);
			expect(retryEndEvents).toHaveLength(1);
			expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
			const lastAssistant = getLastAssistantMessage(session);
			expect(lastAssistant.stopReason).toBe("stop");
			expect(lastAssistant.content).toContainEqual({
				type: "text",
				text: "recovered after bare abort error",
			});
		},
	);

	it("resolves awaitInitialBackgroundRefresh for a refresh started after the waiter is armed", async () => {
		const modelsConfigPath = path.join(tempDir.path(), "late-refresh-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					litellm: {
						baseUrl: "https://litellm.example.net/v1",
						api: "openai-completions",
						discovery: { type: "litellm" },
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsConfigPath);
		const cancelled = new AbortController();
		const cancelledWaiter = registry.awaitInitialBackgroundRefresh(cancelled.signal);
		cancelled.abort();
		await cancelledWaiter;

		// The CLI starts background discovery only after the session — and thus
		// this awaiter — is constructed, so a waiter armed before any refresh must
		// still resolve when the later refresh settles (#10048).
		let settled = false;
		const waiter = registry.awaitInitialBackgroundRefresh().then(() => {
			settled = true;
		});
		await scheduler.wait(10);
		expect(settled).toBe(false);

		registry.refreshInBackground("offline");
		await waiter;
		expect(settled).toBe(true);

		// Once settled, a fresh waiter resolves immediately.
		await registry.awaitInitialBackgroundRefresh();
	});

	it("rebinds the active model to its post-discovery same-selector window (#10488)", async () => {
		// A discovery-backed provider whose live catalog caps a selector below the
		// window the pre-discovery snapshot carried at startup — the same class as
		// the GitHub Copilot gpt-5.6-sol split, where the bundled base ships the
		// full long-context window and discovery caps it to the default tier.
		authStorage.keys.setRuntime("ollama-cloud", "ollama-cloud-test-key");
		const buildTieredModel = (contextWindow: number, input: Model<"ollama-chat">["input"]): Model<"ollama-chat"> =>
			buildModel({
				id: "deepseek-v4-tiered",
				name: "DeepSeek V4 Tiered",
				api: "ollama-chat",
				provider: "ollama-cloud",
				baseUrl: "https://ollama.com",
				reasoning: true,
				input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens: 32_000,
			});
		// Post-discovery catalog: the capped entry the registry resolves for the
		// selector once background discovery settles.
		writeModelCache(
			"ollama-cloud",
			Date.now(),
			[buildTieredModel(400_000, ["text"])],
			true,
			"",
			path.join(tempDir.path(), "models.db"),
		);
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));

		// The startup-bound model is the pre-discovery snapshot for the SAME
		// selector with the full long-context window — what buildSessionOptions
		// pins as options.model before discovery runs.
		const staleModel = buildTieredModel(1_050_000, ["text", "image"]);
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: staleModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
			rebindModelAfterDiscovery: true,
		});

		// Stale until discovery settles: the active model and its context-usage
		// derivation both carry the 1.05M window that contradicts the catalog.
		expect(session.model?.contextWindow).toBe(1_050_000);
		expect(session.getContextUsage()?.contextWindow).toBe(1_050_000);

		const { promise: modelChanged, resolve: resolveModelChanged } = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "model_changed") {
				unsubscribe();
				resolveModelChanged();
			}
		});

		// The CLI starts discovery only after the session is built; the rebind
		// waiter armed in the constructor resolves once this settles.
		registry.refreshInBackground("offline");
		await Promise.race([
			modelChanged,
			scheduler.wait(5_000).then(() => {
				throw new Error("model_changed was not emitted after discovery settled");
			}),
		]);

		// Rebound to the same selector's refreshed 400K window without a manual
		// re-selection; get_state / contextUsage now agree with the catalog.
		expect(session.model?.id).toBe("deepseek-v4-tiered");
		expect(session.model?.contextWindow).toBe(400_000);
		expect(session.getContextUsage()?.contextWindow).toBe(400_000);
	});

	it("auto-retries Gemini MALFORMED_FUNCTION_CALL after an unexecuted tool call", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const malformedError = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
		const requestedModels: string[] = [];
		let toolExecutions = 0;
		const toolSchema = type({ value: type("string") });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "record",
			label: "Record",
			description: "Record a value",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				toolExecutions += 1;
				return { content: [{ type: "text", text: params.value }], details: params };
			},
		};

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "malformed-call",
							name: "record",
							arguments: { value: "must-not-execute" },
						},
					],
					stopReason: "error",
					errorMessage: malformedError,
				},
				{ content: ["Recovered after Gemini malformed function call"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [tool],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from Gemini malformed error");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(toolExecutions).toBe(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		const messages = session.agent.state.messages;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const failedAssistant = messages[1];
		if (failedAssistant.role !== "assistant") {
			throw new Error(`Expected failed assistant message, got ${failedAssistant.role}`);
		}
		expect(failedAssistant.errorMessage).toBe(malformedError);
		const syntheticResult = messages[2];
		if (syntheticResult.role !== "toolResult") {
			throw new Error(`Expected synthetic tool result, got ${syntheticResult.role}`);
		}
		expect(syntheticResult.toolCallId).toBe("malformed-call");
		expect(syntheticResult.details).toMatchObject({ executed: false, source: "assistant_stop_error" });
		const recoveredAssistant = messages[3];
		if (recoveredAssistant.role !== "assistant") {
			throw new Error(`Expected recovered assistant message, got ${recoveredAssistant.role}`);
		}
		const contentBlock = recoveredAssistant.content[0];
		if (contentBlock.type !== "text") {
			throw new Error(`Expected text content block, got ${contentBlock.type}`);
		}
		expect(contentBlock.text).toBe("Recovered after Gemini malformed function call");
	});

	it("continues a Gemini MALFORMED_FUNCTION_CALL transcribed as text with a corrective reminder", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const malformedError = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
		const transcribedCall = "```call:default_api:read{i:Read call_frame.rs,path:src/call_frame.rs:215-320}```";
		const requestContexts: Message[][] = [];
		const mock = createMockModel({
			responses: [
				{ content: [transcribedCall], stopReason: "error", errorMessage: malformedError },
				{ content: ["Recovered after transcribed function call"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			// agent-core's default converter drops developer messages; the CLI wires
			// the coding-agent converter, which is what carries the reminder.
			convertToLlm,
			streamFn: (requestedModel, context, options) => {
				requestContexts.push([...context.messages]);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents } = trackRetryEvents(session);

		await session.prompt("recover from a transcribed function call");
		await session.waitForIdle();

		// The committed text vetoes the replay retry; the preserved-turn continuation
		// must carry the failed turn plus the corrective reminder to the provider.
		expect(retryStartEvents).toHaveLength(0);
		expect(requestContexts).toHaveLength(2);
		const secondRequest = requestContexts[1];
		expect(secondRequest.map(message => message.role)).toEqual(["user", "assistant", "developer"]);
		const failedTurn = secondRequest[1];
		if (failedTurn.role !== "assistant") throw new Error(`Expected assistant, got ${failedTurn.role}`);
		expect(failedTurn.content).toEqual([{ type: "text", text: transcribedCall }]);
		const reminder = secondRequest[2];
		if (reminder.role !== "developer") throw new Error(`Expected developer, got ${reminder.role}`);
		const reminderText =
			typeof reminder.content === "string"
				? reminder.content
				: reminder.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(reminderText).toContain("malformed");

		const messages = session.agent.state.messages;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "developer", "assistant"]);
		const recovered = messages[3];
		if (recovered.role !== "assistant") throw new Error(`Expected assistant, got ${recovered.role}`);
		expect(recovered.content).toEqual([{ type: "text", text: "Recovered after transcribed function call" }]);
	});

	it("auto-retries provider finish_reason errors after partial text", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const errorMessage = "Provider returned error finish_reason";
		const mock = createMockModel({
			responses: [
				{ content: ["   "], stopReason: "error", errorMessage },
				{ content: ["Recovered after provider finish_reason error"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from provider finish_reason error");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].errorMessage).toBe(errorMessage);
		expect(retryEndEvents).toHaveLength(1);
		expect(session.agent.state.messages).toHaveLength(2);
		const assistantMsg = session.agent.state.messages[1];
		if (assistantMsg.role !== "assistant") {
			throw new Error(`Expected assistant message, got ${assistantMsg.role}`);
		}
		const contentBlock = assistantMsg.content[0];
		if (contentBlock.type !== "text") {
			throw new Error(`Expected text content block, got ${contentBlock.type}`);
		}
		expect(contentBlock.text).toBe("Recovered after provider finish_reason error");
	});

	it("reaches the provider and closes the saga when the failed assistant tail was recreated mid-retry", async () => {
		// Issue #5382: a context rebuild can recreate the failed turn's message
		// object between settle and retry (fresh identity, same failed tail), so
		// the identity-keyed removal misses (`agent active context assistant
		// removal missed ... lastRole=assistant lastStopReason=error`). The
		// scheduled continue() then rejected the assistant tail locally before
		// any provider request, auto_retry_end never fired, and the in-flight
		// prompt() hung forever behind the pending retryPromise.
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const errorMessage = "Provider returned error finish_reason";
		const mock = createMockModel({
			responses: [
				{ content: ["   "], stopReason: "error", errorMessage },
				{ content: ["Recovered after tail rebuild"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		// Recreate the failed tail with a fresh object identity while the retry is
		// being scheduled, reproducing the removal-miss state from the issue.
		session.subscribe(event => {
			if (event.type !== "auto_retry_start") return;
			const messages = agent.state.messages;
			const tail = messages.at(-1);
			if (tail?.role !== "assistant" || tail.stopReason !== "error") return;
			agent.replaceMessages([...messages.slice(0, -1), { ...tail, timestamp: tail.timestamp + 1 }]);
		});

		const outcome = await Promise.race([
			session.prompt("recover after the failed tail is rebuilt").then(() => "completed" as const),
			scheduler.wait(3_000).then(() => "stuck" as const),
		]);

		expect(outcome).toBe("completed");
		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true, attempt: 1 })]);
		expect(session.isRetrying).toBe(false);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	it("retries the same model on a thinking-loop error", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled test model");
		const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;

		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: model => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return requestedModels.length === 1
					? thinkingLoopErrorStream(model)
					: recoveredTextStream(model, "Recovered on the same model.");
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": 2,
			"model.loopGuard.enabled": true,
		});
		settings.setModelRole("default", primarySelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});
		mockSchedulerWaitWithClock();

		await session.prompt("Plan the ticket, then act");
		await session.waitForIdle();

		// The thinking-loop abort re-samples the SAME model.
		expect(requestedModels).toEqual([primarySelector, primarySelector]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		// The abort is a thinking-loop, and the retry stayed on the same model.
		expect(retryStartEvents).toHaveLength(1);
		expect(AIError.is(retryStartEvents[0].errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		const finalAssistant = getLastAssistantMessage(session);
		expect(finalAssistant.content).toEqual([{ type: "text", text: "Recovered on the same model." }]);
	});

	it("keeps a SpriliCred pool_exhausted 429 on the selected model despite legacy fallback keys in the config file", async () => {
		const customModel = (id: string) => ({
			id,
			name: `${id} via SpriliCred`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_000,
		});
		const modelsPath = path.join(tempDir.path(), "sprilicred-models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"sprilicred-anthropic": {
						baseUrl: "https://sprilicred.example/anthropic",
						apiKey: "primary-test-key",
						api: "anthropic-messages",
						models: [customModel("claude-sonnet-5-5")],
					},
					"sprilicred-openai": {
						baseUrl: "https://sprilicred.example/v1",
						apiKey: "alternate-test-key",
						api: "openai-responses",
						models: [customModel("gpt-6.2-sol")],
					},
				},
			}),
		);
		// A fresh auth DB: the usage-limit block recorded for the primary must not leak into other tests.
		const isolatedAuth = await AuthStorage.create(":memory:");
		isolatedAuth.keys.setRuntime("sprilicred-anthropic", "primary-test-key");
		isolatedAuth.keys.setRuntime("sprilicred-openai", "alternate-test-key");
		const isolatedRegistry = new ModelRegistry(isolatedAuth, modelsPath);
		const primary = isolatedRegistry.find("sprilicred-anthropic", "claude-sonnet-5-5");
		const alternate = isolatedRegistry.find("sprilicred-openai", "gpt-6.2-sol");
		if (!primary || !alternate) throw new Error("Expected the SpriliCred test models to be registered");
		const primarySelector = `${primary.provider}/${primary.id}`;
		const alternateSelector = `${alternate.provider}/${alternate.id}`;
		// Settings.isolated() rejects unknown keys; a config file on disk is what real users upgrade with.
		const agentDir = path.join(tempDir.path(), "legacy-agent");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			Bun.YAML.stringify({
				modelRoles: { default: primarySelector },
				compaction: { enabled: false },
				retry: {
					maxDelayMs: 30_000,
					modelFallback: true,
					fallbackAfterMs: 0,
					fallbackMinHoldMs: 0,
					compactForFallback: true,
					fallbackRevertPolicy: "cooldown-expiry",
					fallbackChains: { default: [alternateSelector] },
					usageLimitFallbackChains: { default: [alternateSelector] },
				},
			}),
		);
		try {
			const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir });
			const requested: string[] = [];
			const mock = createMockModel();
			// SpriliCred's structured `pool_exhausted` code is what classifies this 429 as a usage limit.
			const poolExhausted = new AIError.ProviderHttpError(
				`429 No Anthropic account can serve ${primary.id}: 3 of 3 resting after provider errors; capacity returns in 4m; retry-after-ms=240000`,
				429,
				{ code: "pool_exhausted" },
			);
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					const selector = `${model.provider}/${model.id}`;
					requested.push(selector);
					if (selector === primarySelector) return poolExhaustedStream(model, poolExhausted);
					mock.push({ content: [`served by ${selector}`] });
					return mock.stream(model, context, options);
				},
			});
			session = new AgentSession({
				agent,
				settings,
				modelRegistry: isolatedRegistry,
				sessionManager: SessionManager.inMemory(),
			});
			const sessionId = session.sessionId;
			const events: AgentSessionEvent[] = [];
			session.subscribe(event => events.push(event));

			await session.prompt("Answer on the model I selected");
			await session.waitForIdle();

			expect(requested).toEqual([primarySelector]);
			expect(`${session.model?.provider}/${session.model?.id}`).toBe(primarySelector);
			expect(session.sessionId).toBe(sessionId);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "model_change")).toHaveLength(0);
			expect(events.filter(event => event.type === "model_changed")).toHaveLength(0);
			const last = getLastAssistantMessage(session);
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toContain("429");
			expect(last.provider).toBe(primary.provider);
			expect(last.model).toBe(primary.id);
		} finally {
			await session?.dispose();
			session = undefined;
			isolatedAuth.close();
			AgentStorage.close();
		}
	});
});
