import { afterEach, describe, expect, it, vi } from "bun:test";
import * as agentCore from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { generateTextReviewContextSummary } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-summary";
import { createSkillDescriptionCompressor } from "@oh-my-pi/pi-coding-agent/extensibility/skill-descriptions";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AGENT_ROLE_HEADER, PARENT_SESSION_ID_HEADER } from "@oh-my-pi/pi-coding-agent/session/side-agent-headers";

// One-shot helpers that run with no provider session id of their own name the
// chat they serve, so a proxy files them under it instead of listing each as a
// chat of its own.

const model: Model<"openai-responses"> = buildModel({
	id: "gpt-4o-mini",
	name: "GPT-4o mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		content: [{ type: "text", text }],
	};
}

const registry = {
	getAvailable: () => [model],
	getApiKey: async () => "test-key",
	resolver: () => async () => "test-key",
	refresh: async () => {},
	find: () => model,
	authStorage: {},
} as unknown as ModelRegistry;

function linkHeaders(parent: string, role: string): Record<string, string> {
	return { [PARENT_SESSION_ID_HEADER]: parent, [AGENT_ROLE_HEADER]: role };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("side request links", () => {
	it("links each skill-description compression to the chat, read per request", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		const spy = vi
			.spyOn(agentCore, "instrumentedCompleteSimple")
			.mockImplementation(async () => reply("Use for browser tasks."));
		let parent = "chat-a";
		const compress = createSkillDescriptionCompressor(registry, settings, undefined, undefined, () => parent);

		await compress("skill", "description", "compress this");
		parent = "chat-b";
		await compress("skill", "description", "compress this");

		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy.mock.calls[0]?.[2]?.headers).toEqual(linkHeaders("chat-a", "helper"));
		expect(spy.mock.calls[1]?.[2]?.headers).toEqual(linkHeaders("chat-b", "helper"));
	});

	it("links the /annotate context summary to the chat", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockImplementation(async () => reply("Context summary."));

		await generateTextReviewContextSummary(
			{
				model,
				modelRegistry: registry,
				sessionManager: { getSessionId: () => "chat-session" },
			} as unknown as Parameters<typeof generateTextReviewContextSummary>[0],
			"Some source text to review.",
		);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[2]?.headers).toEqual(linkHeaders("chat-session", "helper"));
	});

	it("spawns the agents hub's agent generator as a side session of the host chat", async () => {
		const settings = Settings.isolated();
		const spy = vi.spyOn(sdk, "createAgentSession").mockImplementation(async () => {
			throw new Error("capture-stop");
		});
		const deps = createAgentsHubDeps(
			"/tmp",
			settings,
			registry,
			() => ({ explicit: [], configured: [], configuredLevel: "user", mode: "explicit-only" }),
			`${model.provider}/${model.id}`,
			undefined,
			() => "host-chat-session",
		);

		await expect(deps.generateAgent("a reviewer agent", () => {})).rejects.toThrow("capture-stop");

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]?.parentProviderSessionId).toBe("host-chat-session");
	});
});
