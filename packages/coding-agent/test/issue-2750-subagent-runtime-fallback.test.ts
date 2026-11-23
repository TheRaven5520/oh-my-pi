import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { createSessionDefaults } from "./helpers/session-defaults";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

/** Fake session that settles on `initialModel`, optionally changes it before yielding, and yields. */
function createYieldingSession(initialModel: Model<Api>, level: ThinkingLevel | undefined): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		...createSessionDefaults(),
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		model: initialModel,
		thinkingLevel: level,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
	};
	return session as unknown as AgentSession;
}

describe("subagent runtime model resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const { level, collide } of [
		{ level: undefined, collide: false },
		{ level: ThinkingLevel.High, collide: false },
		{ level: ThinkingLevel.Max, collide: true },
	]) {
		it(`keeps literal suffix attribution distinct from thinking (${collide ? "colliding selector" : (level ?? "unset")})`, async () => {
			const literal = model("custom", "coding-router:max");
			const snapshots: AgentProgress[] = [];
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
				if (!options?.model) throw new Error("Expected resolved model");
				// The colliding case settles on a different model whose id plus the thinking
				// level concatenates to the same selector string as the literal model.
				const settled = collide ? model("custom", "coding-router") : options.model;
				return {
					session: createYieldingSession(settled, level),
					extensionsResult: {},
					setToolUIContext: () => {},
				} as never;
			});
			const settings = Settings.isolated({});
			settings.setModelRole("default", "custom/coding-router:max");
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
				task: "work",
				index: 0,
				id: "literal-model",
				modelOverride: level && !collide ? `custom/coding-router:max:${level}` : "custom/coding-router:max",
				settings,
				modelRegistry: {
					refresh: async () => {},
					getAvailable: () => [literal],
					getApiKey: async () => "test-key",
				} as never,
				onProgress: progress => snapshots.push({ ...progress }),
				enableLsp: false,
			});
			const latest = snapshots.findLast(progress => progress.resolvedModel !== undefined);
			const expectedIdentity = collide ? "custom/coding-router" : "custom/coding-router:max";
			expect(latest?.resolvedModelIdentity).toBe(expectedIdentity);
			expect(latest?.resolvedThinkingLevel).toBe(level);
			expect(result.resolvedModel).toBe(level ? `${expectedIdentity}:${level}` : expectedIdentity);
			expect(result.resolvedModelIdentity).toBe(expectedIdentity);
			expect(result.resolvedThinkingLevel).toBe(level);
		});
	}

	it("defers unresolved explicit subagent model selectors instead of picking an available default", async () => {
		const defaultModel = model("zai", "glm-5.2");
		let childModel: Model | undefined;
		let childModelPattern: unknown;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			childModelPattern = options.modelPattern;
			return {
				session: createYieldingSession(defaultModel, undefined),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-4421",
			modelOverride: ["openai-codex/gpt-5.5:auto"],
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [defaultModel],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childModel).toBeUndefined();
		expect(childModelPattern).toEqual(["openai-codex/gpt-5.5:auto"]);
	});
});
