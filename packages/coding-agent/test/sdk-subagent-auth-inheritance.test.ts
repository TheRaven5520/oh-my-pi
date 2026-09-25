import { afterEach, describe, expect, it, vi } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { OAuthCredential, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStreamFnModule from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { AGENT_ROLE_HEADER, PARENT_SESSION_ID_HEADER } from "@oh-my-pi/pi-coding-agent/session/side-agent-headers";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function metadataUserId(metadata: Record<string, unknown> | undefined): {
	session_id: unknown;
	account_uuid: unknown;
} {
	const encoded = metadata?.user_id;
	if (typeof encoded !== "string") throw new Error("Expected encoded user metadata");
	const decoded: unknown = JSON.parse(encoded);
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new Error("Expected user metadata object");
	}
	return {
		session_id: "session_id" in decoded ? decoded.session_id : undefined,
		account_uuid: "account_uuid" in decoded ? decoded.account_uuid : undefined,
	};
}

function subprocessResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Inspect the target.",
		assignment: "Inspect the target.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("task subagent OAuth pin inheritance", () => {
	it("keeps inherited credentials and metadata on the parent's account affinity", async () => {
		const tempDir = TempDir.createSync("@pi-subagent-auth-pin-");
		const authStorage = createInMemoryAuthStorage();
		const sessions: AgentSession[] = [];
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			const otherProviderModel = getBundledModel("openai", "gpt-5-mini");
			if (!model || !otherProviderModel) throw new Error("Expected bundled test models");
			await authStorage.credentials.set("anthropic", [oauthCredential("a"), oauthCredential("b")]);
			authStorage.keys.setRuntime("openai", "openai-key");
			const parentProviderSessionId = "parent-provider-session";
			const accountB = authStorage.oauth
				.accounts("anthropic", parentProviderSessionId)
				.find(account => account.accountId === "account-b");
			if (!accountB) throw new Error("Expected account B");
			expect(authStorage.sessions.pin("anthropic", parentProviderSessionId, accountB.credentialId)).toBe(true);

			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const settings = Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
				"task.batch": true,
				"task.isolation.enabled": false,
				"todo.enabled": false,
			});
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
			const dispatched: executorModule.ExecutorOptions[] = [];
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				dispatched.push(options);
				return subprocessResult(options.id ?? "task");
			});

			const { session: parent } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				providerSessionId: parentProviderSessionId,
				toolNames: ["task"],
				disableExtensionDiscovery: true,
			});
			sessions.push(parent);
			const parentTask = parent.getToolByName("task");
			if (!parentTask) throw new Error("Expected parent task tool");
			await parentTask.execute("parallel-task-call", {
				context: "Check both targets.",
				tasks: [
					{ agent: "task", name: "ChildA", task: "Inspect target A." },
					{ agent: "task", name: "ChildB", task: "Inspect target B." },
				],
			});

			expect(dispatched).toHaveLength(2);
			for (const childOptions of dispatched) {
				expect(childOptions.getApiKey).toBeUndefined();
				expect(childOptions.credentialSourceSessionId).toBe(parentProviderSessionId);
				expect(childOptions.parentProviderSessionId).toBe(parentProviderSessionId);
			}

			// The spawn captured the old affinity. A later parent `/fresh` cannot
			// change which sticky credential is copied into either child.
			parent.agent.sessionId = "rotated-parent-session";
			const children: AgentSession[] = [];
			for (const [index, childOptions] of dispatched.entries()) {
				const providerSessionId = `child-provider-session-${index + 1}`;
				const { session: child } = await createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					sessionManager: SessionManager.inMemory(tempDir.path()),
					authStorage,
					modelRegistry,
					settings,
					model,
					providerSessionId,
					getApiKey: childOptions.getApiKey,
					credentialSourceSessionId: childOptions.credentialSourceSessionId,
					toolNames: ["task"],
					disableExtensionDiscovery: true,
				});
				sessions.push(child);
				children.push(child);
				const childGetApiKey = child.agent.getApiKey;
				if (!childGetApiKey) throw new Error("Expected child credential resolver");
				expect(await resolveApiKeyOnce(await childGetApiKey(model))).toBe("access-b");
				expect(metadataUserId(child.agent.metadataForProvider("anthropic"))).toMatchObject({
					session_id: providerSessionId,
					account_uuid: "account-b",
				});
			}
			const child = children[0];
			if (!child) throw new Error("Expected first child session");
			const childGetApiKey = child.agent.getApiKey;
			if (!childGetApiKey) throw new Error("Expected first child credential resolver");
			expect(await resolveApiKeyOnce(await childGetApiKey(otherProviderModel))).toBe("openai-key");

			const childTask = child.getToolByName("task");
			if (!childTask) throw new Error("Expected child task tool");
			await childTask.execute("nested-task-call", {
				context: "Check the nested target.",
				tasks: [{ agent: "task", name: "Grandchild", task: "Inspect the nested target." }],
			});

			expect(dispatched).toHaveLength(3);
			const nestedOptions = dispatched[2];
			if (!nestedOptions) throw new Error("Expected nested child options");
			expect(nestedOptions.getApiKey).toBeUndefined();
			expect(nestedOptions.credentialSourceSessionId).toBe("child-provider-session-1");
			expect(nestedOptions.parentProviderSessionId).toBe("child-provider-session-1");
			const { session: grandchild } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				providerSessionId: "grandchild-provider-session",
				getApiKey: nestedOptions.getApiKey,
				credentialSourceSessionId: nestedOptions.credentialSourceSessionId,
				toolNames: ["task"],
				disableExtensionDiscovery: true,
			});
			sessions.push(grandchild);
			const grandchildGetApiKey = grandchild.agent.getApiKey;
			if (!grandchildGetApiKey) throw new Error("Expected grandchild credential resolver");
			expect(await resolveApiKeyOnce(await grandchildGetApiKey(model))).toBe("access-b");
			expect(metadataUserId(grandchild.agent.metadataForProvider("anthropic"))).toMatchObject({
				session_id: "grandchild-provider-session",
				account_uuid: "account-b",
			});
		} finally {
			for (const session of sessions.reverse()) await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	it("sends x-omp parent/role headers on subagent requests but not on the parent's", async () => {
		const tempDir = TempDir.createSync("@pi-subagent-link-headers-");
		const authStorage = createInMemoryAuthStorage();
		const sessions: AgentSession[] = [];
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			authStorage.keys.setRuntime("anthropic", "test-key");
			const captured: Array<SimpleStreamOptions | undefined> = [];
			const captureStreamFn: StreamFn = (_m, _ctx, opts) => {
				captured.push(opts);
				throw new Error("capture-stop");
			};
			vi.spyOn(settingsStreamFnModule, "createSettingsAwareStreamFn").mockReturnValue(captureStreamFn);
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const settings = Settings.isolated({ "async.enabled": false, "compaction.enabled": false });
			const create = (providerSessionId: string, parentProviderSessionId?: string) =>
				createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					sessionManager: SessionManager.inMemory(tempDir.path()),
					authStorage,
					modelRegistry,
					settings,
					model,
					providerSessionId,
					parentProviderSessionId,
					toolNames: [],
					disableExtensionDiscovery: true,
				});
			const { session: parent } = await create("parent-provider-session");
			sessions.push(parent);
			const { session: child } = await create("child-provider-session", "parent-provider-session");
			sessions.push(child);

			const context = { systemPrompt: ["Test"], messages: [] };
			expect(() => parent.agent.streamFn(model, context, {})).toThrow("capture-stop");
			expect(() => child.agent.streamFn(model, context, { headers: { "x-caller": "kept" } })).toThrow(
				"capture-stop",
			);
			expect(captured).toHaveLength(2);
			expect(captured[0]?.headers?.[PARENT_SESSION_ID_HEADER]).toBeUndefined();
			expect(captured[0]?.headers?.[AGENT_ROLE_HEADER]).toBeUndefined();
			expect(captured[1]?.headers).toEqual({
				"x-caller": "kept",
				[PARENT_SESSION_ID_HEADER]: "parent-provider-session",
				[AGENT_ROLE_HEADER]: "subagent",
			});
		} finally {
			for (const session of sessions.reverse()) await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	it("links a top-level session's main requests to its chat only while a /fresh id is active", async () => {
		// /fresh swaps in a bare UUIDv7 provider id (a proxy files chats by
		// UUID); the `fresh` link names the session file id the chat is filed under.
		const tempDir = TempDir.createSync("@pi-fresh-link-headers-");
		const authStorage = createInMemoryAuthStorage();
		const sessions: AgentSession[] = [];
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			authStorage.keys.setRuntime("anthropic", "test-key");
			const captured: Array<SimpleStreamOptions | undefined> = [];
			const captureStreamFn: StreamFn = (_m, _ctx, opts) => {
				captured.push(opts);
				throw new Error("capture-stop");
			};
			vi.spyOn(settingsStreamFnModule, "createSettingsAwareStreamFn").mockReturnValue(captureStreamFn);
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
				settings: Settings.isolated({ "async.enabled": false, "compaction.enabled": false }),
				model,
				toolNames: [],
				disableExtensionDiscovery: true,
			});
			sessions.push(session);
			const fileSessionId = sessionManager.getSessionId();
			const context = { systemPrompt: ["Test"], messages: [] };

			expect(() => session.agent.streamFn(model, context, {})).toThrow("capture-stop");
			const fresh = session.freshSession();
			expect(() => session.agent.streamFn(model, context, {})).toThrow("capture-stop");
			await session.newSession();
			expect(() => session.agent.streamFn(model, context, {})).toThrow("capture-stop");

			expect(fresh?.sessionId).not.toBe(fileSessionId);
			expect(captured).toHaveLength(3);
			expect(captured[0]?.headers?.[PARENT_SESSION_ID_HEADER]).toBeUndefined();
			expect(captured[1]?.headers).toEqual({
				[PARENT_SESSION_ID_HEADER]: fileSessionId,
				[AGENT_ROLE_HEADER]: "fresh",
			});
			expect(captured[2]?.headers?.[PARENT_SESSION_ID_HEADER]).toBeUndefined();
		} finally {
			for (const session of sessions.reverse()) await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	it("links side requests to the parent on subagents and to the chat on the main session", async () => {
		// Side turns (recap, `/btw`) run under a derived `:side:` lineage id. The
		// header keeps them linked when that id alone cannot be (a subagent id the
		// proxy may not know yet, or an id hashed past OpenAI's key limit).
		const tempDir = TempDir.createSync("@pi-subagent-side-link-headers-");
		const authStorage = createInMemoryAuthStorage();
		const sessions: AgentSession[] = [];
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			authStorage.keys.setRuntime("anthropic", "test-key");
			const captured: Array<SimpleStreamOptions | undefined> = [];
			const captureStreamFn: StreamFn = (_m, _ctx, opts) => {
				captured.push(opts);
				throw new Error("capture-stop");
			};
			vi.spyOn(settingsStreamFnModule, "createSettingsAwareStreamFn").mockReturnValue(captureStreamFn);
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const settings = Settings.isolated({ "async.enabled": false, "compaction.enabled": false });
			const create = (providerSessionId: string, parentProviderSessionId?: string) =>
				createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					sessionManager: SessionManager.inMemory(tempDir.path()),
					authStorage,
					modelRegistry,
					settings,
					model,
					providerSessionId,
					parentProviderSessionId,
					toolNames: [],
					disableExtensionDiscovery: true,
				});
			const { session: parent } = await create("parent-provider-session");
			sessions.push(parent);
			const { session: child } = await create("child-provider-session", "parent-provider-session");
			sessions.push(child);

			await expect(parent.runEphemeralTurn({ promptText: "Recap the session." })).rejects.toThrow("capture-stop");
			await expect(child.runEphemeralTurn({ promptText: "Recap the session." })).rejects.toThrow("capture-stop");

			expect(captured).toHaveLength(2);
			expect(captured[0]?.headers).toMatchObject({
				[PARENT_SESSION_ID_HEADER]: "parent-provider-session",
				[AGENT_ROLE_HEADER]: "helper",
			});
			expect(captured[1]?.headers).toMatchObject({
				[PARENT_SESSION_ID_HEADER]: "parent-provider-session",
				[AGENT_ROLE_HEADER]: "subagent",
			});
		} finally {
			for (const session of sessions.reverse()) await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});
});
