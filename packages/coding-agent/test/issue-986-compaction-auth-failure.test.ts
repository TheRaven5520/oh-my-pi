import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";
import { assistantMsg, userMsg } from "./utilities";

import { cfgRetryBaseDelayMs, cfgRetryEnabled, cfgRetryMaxRetries } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("issue #986 compaction auth failures", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-issue-986-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	function appendConversation(): void {
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
	}

	async function createSession() {
		const bundledCurrentModel = getBundledModel("openai-codex", "gpt-5.5");
		const currentModel = bundledCurrentModel && {
			...bundledCurrentModel,
			remoteCompaction: {
				...bundledCurrentModel.remoteCompaction,
				enabled: true,
				endpoint: "https://compact.example/v1/responses/compact",
			},
		};
		if (!currentModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["remote", "soft"],
		});

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(currentModel.provider, "codex-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		appendConversation();
		return { currentModel };
	}

	async function createAutoNativeSession(options?: { includeSoftMethod?: boolean }) {
		const currentModel = getBundledModel("openai", "gpt-5");
		if (!currentModel) {
			throw new Error("Expected bundled native compaction test model");
		}

		const settings = Settings.isolated({
			"compaction.autoContinue": false,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": options?.includeSoftMethod ? ["remote", "soft"] : ["remote"],
		});
		const agent = new Agent({
			initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(currentModel.provider, "openai-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		appendConversation();
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([currentModel]);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		const triggerAutoCompaction = async (): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "auto_compaction_end") resolve();
			});
			const contextWindow = currentModel.contextWindow;
			if (!contextWindow) throw new Error("Expected current model context window");
			const assistant = {
				...assistantMsg("threshold reached"),
				api: currentModel.api,
				provider: currentModel.provider,
				model: currentModel.id,
				usage: {
					input: contextWindow,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: contextWindow + 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
			await promise;
			await session.waitForIdle();
		};

		return { currentModel, triggerAutoCompaction };
	}

	it("retries a transient native compaction failure on the same model", async () => {
		const { currentModel, triggerAutoCompaction } = await createAutoNativeSession();
		cfgRetryEnabled.set(session.settings, true);
		cfgRetryBaseDelayMs.set(session.settings, 1);
		cfgRetryMaxRetries.set(session.settings, 1);
		const waitSpy = mockSchedulerWaitWithClock();
		const attemptedModels: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			attemptedModels.push(`${model.provider}/${model.id}`);
			if (model.provider !== currentModel.provider || model.id !== currentModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			if (attemptedModels.length === 1) {
				throw new compactionModule.NativeCompactionError(
					new AIError.ProviderHttpError("native compaction temporarily unavailable", 503),
				);
			}
			return {
				summary: "native retry summary",
				shortSummary: "native retry",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await triggerAutoCompaction();

		expect(attemptedModels).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${currentModel.provider}/${currentModel.id}`,
		]);
		expect(waitSpy).toHaveBeenCalledTimes(1);
	});

	it("falls through to soft compaction on the same model after a native authentication failure", async () => {
		const { currentModel, triggerAutoCompaction } = await createAutoNativeSession({ includeSoftMethod: true });
		const attempts: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			attempts.push(
				`${preparation.settings.remoteEnabled === true ? "remote" : "soft"}:${model.provider}/${model.id}`,
			);
			if (model.provider !== currentModel.provider || model.id !== currentModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			if (preparation.settings.remoteEnabled === true) {
				throw new compactionModule.NativeCompactionError(
					Object.assign(new Error("native compaction authentication failed"), { status: 401 }),
				);
			}
			return {
				summary: "soft summary",
				shortSummary: "soft",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await triggerAutoCompaction();

		expect(attempts).toEqual([
			`remote:${currentModel.provider}/${currentModel.id}`,
			`soft:${currentModel.provider}/${currentModel.id}`,
		]);
	});

	it("fails fast with a clear provider-specific error when the compaction call lacks credentials", async () => {
		const { currentModel } = await createSession();
		vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new Error(
					"Summarization failed: 503 auth_unavailable: no auth available (providers=codex, model=gpt-5.4-mini)",
				);
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "codex-token";
			return undefined;
		});

		const error = await session.compact().catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}`,
		);
		expect((error as Error).message).not.toMatch(/auth_unavailable/i);
	});

	it("fails fast with the configured-credentials hint when the provider rejects the credential with a 401", async () => {
		const { currentModel } = await createSession();
		vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw Object.assign(
					new Error(
						'Summarization failed: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
					),
					{ status: 401 },
				);
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "stale-codex-token";
			return undefined;
		});

		const error = await session.compact().catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}`,
		);
		// The raw provider envelope must not leak into the actionable error.
		expect((error as Error).message).not.toContain("authentication_error");
		expect((error as Error).message).not.toMatch(/\b401\b/);
	});
});
