import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AGENT_ROLE_HEADER, PARENT_SESSION_ID_HEADER } from "@oh-my-pi/pi-coding-agent/session/side-agent-headers";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// The auto-thinking judge can be a session's very first request, and a proxy
// files a new thread under the first link it sees. The judge therefore carries
// exactly the main requests' link: a subagent names its spawner as `subagent`,
// a top-level session sends none (or names its chat as `fresh` after /fresh).
describe("auto-thinking judge link", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;
	let authRoot: string;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-judge-link-auth-"));
		authStorage = await AuthStorage.create(path.join(authRoot, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(authRoot, "models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		await removeWithRetries(authRoot);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		session = undefined;
	});

	function createAutoThinkingSession(parentProviderSessionId?: string): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Claude Sonnet model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			parentProviderSessionId,
		});
		vi.spyOn(created.agent, "prompt").mockResolvedValue(undefined);
		created.setThinkingLevel(AUTO_THINKING);
		return created;
	}

	it("links a subagent's judge request to the spawning session", async () => {
		session = createAutoThinkingSession("parent-provider-session");
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);

		await session.prompt("refactor the scheduler across its callers");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(classifierSpy.mock.calls[0]?.[1].sessionId).toBe(session.sessionId);
		expect(classifierSpy.mock.calls[0]?.[1].headers).toEqual({
			[PARENT_SESSION_ID_HEADER]: "parent-provider-session",
			[AGENT_ROLE_HEADER]: "subagent",
		});
	});

	it("sends no link from a top-level session until /fresh swaps its provider id", async () => {
		session = createAutoThinkingSession();
		const fileSessionId = session.sessionManager.getSessionId();
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);

		await session.prompt("refactor the scheduler across its callers");
		session.freshSession();
		await session.prompt("now split the scheduler into two modules");

		expect(classifierSpy).toHaveBeenCalledTimes(2);
		expect(classifierSpy.mock.calls[0]?.[1].headers).toBeUndefined();
		expect(classifierSpy.mock.calls[1]?.[1].sessionId).not.toBe(fileSessionId);
		expect(classifierSpy.mock.calls[1]?.[1].headers).toEqual({
			[PARENT_SESSION_ID_HEADER]: fileSessionId,
			[AGENT_ROLE_HEADER]: "fresh",
		});
	});
});
