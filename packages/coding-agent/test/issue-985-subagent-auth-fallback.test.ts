import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { kNoAuth } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	type ModelLookupRegistry,
	resolveAuthenticatedModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/**
 * Regression test for #985.
 *
 * A task subagent resolved to `qwen3.6-plus-free` — an opencode-zen model the
 * user has no working credentials for. Dispatch never silently reroutes to
 * another model (such as the parent's): among the requested patterns only, the
 * first authenticated one wins, else the first resolved model is kept so the
 * real credential error surfaces.
 */

const parentModel: Model<Api> = buildModel({
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const unauthedTaskModel: Model<Api> = buildModel({
	id: "qwen3.6-plus-free",
	name: "Qwen3.6 Plus Free",
	api: "openai-completions",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const sharedModel: Model<Api> = buildModel({
	id: "shared-id",
	name: "Shared",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

type AuthRegistry = ModelLookupRegistry & {
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
};

function createMockRegistry(models: Model<Api>[], authedProviders: Set<string>): AuthRegistry {
	return {
		getAvailable: () => models,
		getApiKey: async (model: Model<Api>) => (authedProviders.has(model.provider) ? "sk-test-token" : undefined),
	} as unknown as AuthRegistry;
}

describe("issue #985: subagent model resolution never leaves the requested patterns", () => {
	test("keeps an unauthenticated single requested model instead of swapping to another", async () => {
		// The user has DeepSeek; opencode-zen is unauthenticated.
		const registry = createMockRegistry([parentModel, unauthedTaskModel], new Set(["deepseek"]));

		const result = await resolveAuthenticatedModelOverride(["qwen3.6-plus-free"], registry);

		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("keeps the first requested model when none of several requested models is authenticated", async () => {
		const registry = createMockRegistry([parentModel, unauthedTaskModel], new Set(["deepseek"]));

		const result = await resolveAuthenticatedModelOverride(
			["opencode-zen/qwen3.6-plus-free", "opencode-zen/qwen3.6-plus-free:high"],
			registry,
		);

		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.explicitThinkingLevel).toBe(false);
	});

	test("treats keyless providers (kNoAuth marker) as authenticated", async () => {
		// Keyless-by-design providers (Ollama, llama.cpp, lm-studio) advertise the
		// kNoAuth sentinel from getApiKey to signal that they do not require
		// credentials, so an explicitly requested local model keeps its place (see #1008).
		const registry = {
			getAvailable: () => [unauthedTaskModel, parentModel],
			getApiKey: async (model: Model<Api>) => {
				if (model.provider === "deepseek") return "sk-test";
				if (model.provider === "opencode-zen") return kNoAuth;
				return undefined;
			},
		} as unknown as AuthRegistry;

		const result = await resolveAuthenticatedModelOverride(
			["opencode-zen/qwen3.6-plus-free", "deepseek/deepseek-v4-pro"],
			registry,
		);

		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});
});

describe("issue #5325: sessionId forwarded to getApiKey for session-sticky OAuth", () => {
	// The pre-flight auth check calls getApiKey; for providers with session-sticky
	// OAuth credentials, omitting the session id can return undefined even though
	// the credential is usable once the subagent session starts.
	test("forwards sessionId to getApiKey for every requested model it checks", async () => {
		const receivedSessionIds: string[] = [];
		const registry = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, sessionId?: string) => {
				if (sessionId) receivedSessionIds.push(`${model.provider}:${sessionId}`);
				if (model.provider === "opencode-zen") return undefined;
				return sessionId ? "sk-resolved-token" : undefined;
			},
		} as unknown as AuthRegistry;

		const result = await resolveAuthenticatedModelOverride(
			["opencode-zen/qwen3.6-plus-free", "deepseek/deepseek-v4-pro"],
			registry,
			undefined,
			"subagent-session-456",
		);

		expect(receivedSessionIds).toEqual(["opencode-zen:subagent-session-456", "deepseek:subagent-session-456"]);
		expect(result.model?.provider).toBe("deepseek");
	});
});

describe("issue #11709: disabled provider subagent model resolution", () => {
	afterEach(() => {
		resetSettingsForTest();
	});

	test("skips an authenticated model from a disabled provider", async () => {
		const settings = await Settings.init({
			inMemory: true,
			overrides: { disabledProviders: ["opencode-zen"] },
		});
		const registry = createMockRegistry([unauthedTaskModel, parentModel], new Set(["opencode-zen", "deepseek"]));

		const result = await resolveAuthenticatedModelOverride(
			["opencode-zen/qwen3.6-plus-free", "deepseek/deepseek-v4-pro"],
			registry,
			settings,
		);

		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
	});
});

describe("requested candidate authentication order", () => {
	test("uses a later authenticated candidate", async () => {
		const registry = createMockRegistry([parentModel, unauthedTaskModel, sharedModel], new Set(["deepseek"]));
		const resolved = await resolveAuthenticatedModelOverride(
			["opencode-zen/qwen3.6-plus-free", "deepseek/shared-id:high"],
			registry,
		);
		expect(resolved.model?.id).toBe("shared-id");
		expect(resolved.explicitThinkingLevel).toBe(true);
	});

	test("exhausts candidates inside a configured role", async () => {
		const settings = Settings.isolated({ modelRoles: { qa: "opencode-zen/qwen3.6-plus-free,deepseek/shared-id" } });
		const registry = createMockRegistry([parentModel, unauthedTaskModel, sharedModel], new Set(["deepseek"]));
		const resolved = await resolveAuthenticatedModelOverride(["@qa"], registry, settings);
		expect(resolved.model?.id).toBe("shared-id");
	});
});
