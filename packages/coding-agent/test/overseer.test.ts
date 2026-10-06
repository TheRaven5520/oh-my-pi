import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { cfgAdvisorOverseer } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type AdvisorAgent, AdvisorRuntime } from "../src/advisor/runtime";
import { Settings } from "../src/config/settings";
import overseerSystemPrompt from "../src/prompts/advisor/overseer.md" with { type: "text" };
import { AgentSession } from "../src/session/agent-session";
import type { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

interface OverseerSessionOptions {
	overseer?: boolean;
	advisorConfigs?: AdvisorConfig[];
	syncBacklogOff?: boolean;
	streamFn?: StreamFn;
	advisorStreamFn?: StreamFn;
	extensionRunner?: unknown;
}

function promptText(input: string | AgentMessage[]): string {
	if (typeof input === "string") return input;
	return input
		.map(message => {
			if (!("content" in message)) return "";
			const content = message.content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content.map(part => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
		})
		.join("\n");
}

function advise(note: string, severity: "blocker" | "concern"): MockResponse {
	return { content: [{ type: "toolCall", name: "advise", arguments: { note, severity } }], stopReason: "toolUse" };
}

const SILENT: MockResponse = { content: [], stopReason: "stop" };

function toolStart(toolCallId: string) {
	return { type: "tool_execution_start" as const, toolCallId, toolName: "bash", args: { command: "sleep 600" } };
}

function toolEnd(toolCallId: string) {
	return {
		type: "tool_execution_end" as const,
		toolCallId,
		toolName: "bash",
		result: { content: [{ type: "text", text: "done" }] },
	};
}

describe("built-in Overseer", () => {
	const sessions: AgentSession[] = [];
	const tempDirs: TempDir[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const current of sessions.splice(0)) await current.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
	});

	function createSession(options: OverseerSessionOptions = {}): AgentSession {
		const tempDir = TempDir.createSync("@pi-overseer-");
		tempDirs.push(tempDir);
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled primary model");
		const settings = Settings.isolated({
			"advisor.enabled": true,
			"compaction.enabled": false,
			"retry.enabled": false,
			...(options.syncBacklogOff ? { "advisor.syncBacklog": "off" as const } : {}),
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Overseer regression"], tools: [] },
			convertToLlm,
			streamFn: options.streamFn,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			overseer: options.overseer ?? true,
			advisorConfigs: options.advisorConfigs,
			advisorTools: [],
			advisorStreamFn: options.advisorStreamFn,
			extensionRunner: options.extensionRunner as never,
		});
		sessions.push(session);
		return session;
	}

	function rosterNames(session: AgentSession): string[] {
		return session.getAdvisorStats().advisors.map(advisor => advisor.name);
	}

	/** Lets the setting's coalesced microtask listener apply a live toggle. */
	async function applyOverseerToggle(session: AgentSession, on: boolean): Promise<void> {
		cfgAdvisorOverseer.set(session.settings, on);
		await Promise.resolve();
	}

	/**
	 * Routes every advisor request through one stream and lets only the
	 * advisor running the dedicated Overseer prompt produce `overseer`.
	 */
	function routeAdvisors(overseer: StreamFn, ordinary: StreamFn): { stream: StreamFn; overseerCalls: () => number } {
		let overseerCalls = 0;
		const stream: StreamFn = (model, context, streamOptions) => {
			if ((context.systemPrompt ?? []).some(part => part.includes(overseerSystemPrompt.trim()))) {
				overseerCalls++;
				return overseer(model, context, streamOptions);
			}
			return ordinary(model, context, streamOptions);
		};
		return { stream, overseerCalls: () => overseerCalls };
	}

	it("adds Overseer beside the legacy advisor only for opted-in sessions and follows the live toggle", async () => {
		const main = createSession();
		expect(rosterNames(main)).toEqual(["default", "Overseer"]);
		await applyOverseerToggle(main, false);
		expect(rosterNames(main)).toEqual(["default"]);
		await applyOverseerToggle(main, true);
		expect(rosterNames(main)).toEqual(["default", "Overseer"]);

		const ordinary = createSession({ overseer: false });
		expect(rosterNames(ordinary)).toEqual(["default"]);
	});

	it("keeps a WATCHDOG overseer entry as an ordinary advisor while the built-in toggle is off", async () => {
		const session = createSession({ advisorConfigs: [{ name: "overseer" }] });
		const ticks = vi.spyOn(AdvisorRuntime.prototype, "enqueueSynthetic").mockImplementation(() => {});

		await applyOverseerToggle(session, false);
		expect(rosterNames(session)).toEqual(["overseer"]);
		vi.useFakeTimers();
		session.agent.emitExternalEvent(toolStart("while-off"));
		await session.waitForIdle();
		vi.advanceTimersByTime(20_000);
		expect(ticks).toHaveBeenCalledTimes(0);
		session.agent.emitExternalEvent(toolEnd("while-off"));
		await session.waitForIdle();
		vi.useRealTimers();

		await applyOverseerToggle(session, true);
		expect(rosterNames(session)).toEqual(["overseer"]);
		vi.useFakeTimers();
		session.agent.emitExternalEvent(toolStart("while-on"));
		await session.waitForIdle();
		vi.advanceTimersByTime(20_000);
		expect(ticks).toHaveBeenCalledTimes(1);
	});

	it("reviews a slow tool at each backoff boundary and stops after five ticks", async () => {
		const session = createSession();
		const ticks = vi.spyOn(AdvisorRuntime.prototype, "enqueueSynthetic").mockImplementation(() => {});
		vi.useFakeTimers();
		session.agent.emitExternalEvent(toolStart("slow-bash"));
		await session.waitForIdle();

		let expected = 0;
		for (const delay of [20_000, 60_000, 120_000, 300_000, 300_000]) {
			vi.advanceTimersByTime(delay - 1);
			expect(ticks).toHaveBeenCalledTimes(expected);
			vi.advanceTimersByTime(1);
			expect(ticks).toHaveBeenCalledTimes(++expected);
		}
		vi.advanceTimersByTime(3_600_000);
		expect(ticks).toHaveBeenCalledTimes(5);
	});

	it("stops wall-clock review when the tool ends, the conversation resets, or the session is disposed", async () => {
		const session = createSession();
		const ticks = vi.spyOn(AdvisorRuntime.prototype, "enqueueSynthetic").mockImplementation(() => {});
		vi.useFakeTimers();

		session.agent.emitExternalEvent(toolStart("ended"));
		await session.waitForIdle();
		vi.advanceTimersByTime(19_999);
		session.agent.emitExternalEvent(toolEnd("ended"));
		await session.waitForIdle();
		vi.advanceTimersByTime(600_000);
		expect(ticks).toHaveBeenCalledTimes(0);

		session.agent.emitExternalEvent(toolStart("reset"));
		await session.waitForIdle();
		expect(await session.newSession()).toBe(true);
		vi.advanceTimersByTime(600_000);
		expect(ticks).toHaveBeenCalledTimes(0);

		session.agent.emitExternalEvent(toolStart("disposed"));
		await session.waitForIdle();
		sessions.splice(sessions.indexOf(session), 1);
		await session.dispose();
		vi.advanceTimersByTime(600_000);
		expect(ticks).toHaveBeenCalledTimes(0);
	});

	it("does not review a finished tool while its end hooks are still running", async () => {
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const session = createSession({
			extensionRunner: {
				hasHandlers: (eventType: string) => eventType === "tool_execution_end",
				emitBeforeAgentStart: async () => undefined,
				emit: async (event: { type: string }) => {
					if (event.type !== "tool_execution_end") return;
					hookStarted.resolve();
					await releaseHook.promise;
				},
			},
		});
		const ticks = vi.spyOn(AdvisorRuntime.prototype, "enqueueSynthetic").mockImplementation(() => {});
		vi.useFakeTimers();
		try {
			session.agent.emitExternalEvent(toolStart("hooked"));
			await session.waitForIdle();
			vi.advanceTimersByTime(19_999);
			session.agent.emitExternalEvent(toolEnd("hooked"));
			await hookStarted.promise;
			vi.advanceTimersByTime(600_000);
			expect(ticks).toHaveBeenCalledTimes(0);
		} finally {
			releaseHook.resolve();
		}
		await session.waitForIdle();
	});

	it("gives the first wall-clock tick the pending primary request without replaying it later", async () => {
		const promptInputs: Array<string | AgentMessage[]> = [];
		const agent: AdvisorAgent = {
			prompt: async input => {
				promptInputs.push(input);
			},
			abort: () => {},
			reset: () => {},
			state: { messages: [] },
		};
		const call = createAssistantMessage("");
		call.content = [{ type: "toolCall", id: "slow-call", name: "bash", arguments: { command: "sleep 600" } }];
		call.stopReason = "toolUse";
		const messages: AgentMessage[] = [
			{ role: "user", content: "PRIMARY_REQUEST_MARKER", timestamp: 1 } as AgentMessage,
			call,
		];
		const runtime = new AdvisorRuntime(agent, { snapshotMessages: () => messages }, 0);

		runtime.enqueueSynthetic("TICK_MARKER bash still running");
		expect(await runtime.waitForCatchup(1_000, 1)).toBe(true);
		expect(promptInputs).toHaveLength(1);
		const tick = promptText(promptInputs[0]!);
		expect(tick).toContain("PRIMARY_REQUEST_MARKER");
		expect(tick).toContain("TICK_MARKER bash still running");

		messages.push(
			{
				role: "toolResult",
				toolCallId: "slow-call",
				toolName: "bash",
				content: [{ type: "text", text: "TOOL_OUTPUT_MARKER" }],
				isError: false,
				timestamp: 3,
			} as AgentMessage,
			createAssistantMessage("finished"),
		);
		runtime.onTurnEnd(messages);
		expect(await runtime.waitForCatchup(1_000, 1)).toBe(true);
		expect(promptInputs).toHaveLength(2);
		const boundary = promptText(promptInputs[1]!);
		expect(boundary).toContain("TOOL_OUTPUT_MARKER");
		expect(boundary).not.toContain("PRIMARY_REQUEST_MARKER");
	});

	it("resumes a prematurely finished primary run from an Overseer blocker without a user prompt", async () => {
		const note = "OVERSEER_BLOCKER_NOTE";
		const continuationStarted = Promise.withResolvers<void>();
		const primaryContexts: string[] = [];
		const primary = createMockModel({
			responses: [{ content: ["premature final answer"], stopReason: "stop" }],
			handler: () => {
				continuationStarted.resolve();
				return { content: ["continued after Overseer"], stopReason: "stop" };
			},
		});
		const overseer = createMockModel({ responses: [advise(note, "blocker")], handler: SILENT });
		const ordinary = createMockModel({ handler: SILENT });
		const advisors = routeAdvisors(overseer.stream, ordinary.stream);
		const session = createSession({
			streamFn: (model, context, options) => {
				primaryContexts.push(JSON.stringify(context.messages));
				return primary.stream(model, context, options);
			},
			advisorStreamFn: advisors.stream,
		});

		await session.prompt("finish the task");
		await continuationStarted.promise;
		await session.waitForIdle();

		expect(advisors.overseerCalls()).toBeGreaterThanOrEqual(1);
		expect(primary.calls).toHaveLength(2);
		expect(primaryContexts[0]).not.toContain(note);
		expect(primaryContexts[1]).toContain(note);
		const userTurns = session.agent.state.messages.filter(
			message => message.role === "user" && message.attribution !== "agent",
		);
		expect(userTurns).toHaveLength(1);
	});

	it("preserves an Overseer blocker as a card after an explicit user interrupt", async () => {
		const note = "OVERSEER_SUPPRESSED_BLOCKER";
		const overseerStarted = Promise.withResolvers<void>();
		const releaseOverseer = Promise.withResolvers<void>();
		const primary = createMockModel({
			responses: [{ content: ["premature final answer"], stopReason: "stop" }],
			handler: { content: ["must not auto-resume"], stopReason: "stop" },
		});
		const overseer = createMockModel({
			responses: [
				async () => {
					overseerStarted.resolve();
					await releaseOverseer.promise;
					return advise(note, "blocker");
				},
			],
			handler: SILENT,
		});
		const ordinary = createMockModel({ handler: SILENT });
		const session = createSession({
			syncBacklogOff: true,
			streamFn: primary.stream,
			advisorStreamFn: routeAdvisors(overseer.stream, ordinary.stream).stream,
		});

		try {
			await session.prompt("finish the task");
			await overseerStarted.promise;
			await session.abort({ reason: USER_INTERRUPT_LABEL });
		} finally {
			releaseOverseer.resolve();
		}
		expect(await session.waitForAdvisorCatchup(5_000)).toBe(true);
		await session.waitForIdle();

		expect(primary.calls).toHaveLength(1);
		const cards = session.agent.state.messages.filter(
			message => message.role === "custom" && "customType" in message && message.customType === "advisor",
		);
		expect(cards).toHaveLength(1);
		expect(JSON.stringify(cards[0])).toContain(note);
	});
});
