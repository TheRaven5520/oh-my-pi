import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { ForkCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/fork-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as Model;

interface ForkSessionEvent {
	type: string;
	result?: unknown;
	aborted?: boolean;
}

/** Minimal fork session covering what the controller drives. */
function createForkStub() {
	const agentMessages: AgentMessage[] = [];
	const persisted: unknown[] = [];
	let listener: ((event: ForkSessionEvent) => void) | undefined;
	let finishTurn = () => {};
	let idle: Promise<void> = Promise.resolve();
	const session = {
		agent: {
			appendMessage: vi.fn((message: AgentMessage) => {
				agentMessages.push(message);
			}),
		},
		sessionManager: { appendMessage: vi.fn((message: unknown) => persisted.push(message)) },
		setTodoPhases: vi.fn(),
		isStreaming: false,
		subscribe: vi.fn((l: (event: ForkSessionEvent) => void) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		}),
		subscribeRunState: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		waitForIdle: vi.fn(() => idle),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	};
	return {
		session,
		agentMessages,
		persisted,
		emit(event: ForkSessionEvent) {
			listener?.(event);
		},
		/** Keep waitForIdle() pending, as while the reporting turn is still finishing. */
		holdIdle() {
			const pending = Promise.withResolvers<void>();
			idle = pending.promise;
			finishTurn = pending.resolve;
		},
		finishTurn() {
			finishTurn();
		},
	};
}

function createHarness() {
	const tempDir = TempDir.createSync("@omp-fork-controller-");
	const parentFile = path.join(tempDir.path(), "parent.jsonl");
	const artifactsDir = parentFile.slice(0, -6);
	const session = {
		isStreaming: false,
		agent: { promptCacheKey: undefined },
		model,
		sessionId: "parent-session",
		configuredThinkingLevel: vi.fn(() => undefined),
		systemPrompt: ["system prompt"],
		getEnabledToolNames: vi.fn(() => ["read", "edit", "hub"]),
		modelRegistry: { authStorage: {} },
		getAgentId: vi.fn(() => undefined),
		sendCustomMessage: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext["session"];
	const getSessionFile = vi.fn((): string | undefined => parentFile);
	const sessionManager = {
		getSessionFile,
		getCwd: vi.fn(() => tempDir.path()),
		getArtifactsDir: vi.fn(() => artifactsDir),
		getSessionId: vi.fn(() => "parent-local-session"),
		ensureOnDisk: vi.fn(async () => {}),
		flush: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext["sessionManager"];
	const ctx = {
		session,
		sessionManager,
		settings: Settings.isolated({}),
		showStatus: vi.fn(),
		showError: vi.fn(),
		focusAgentSession: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext;
	const cloneManager = { appendCustomEntry: vi.fn(), close: vi.fn(async () => {}) } as unknown as SessionManager;
	const forkSpy = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(cloneManager);
	const fork = createForkStub();
	let options: CreateAgentSessionOptions | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async received => {
		const opts: CreateAgentSessionOptions = received ?? {};
		options = opts;
		// The SDK registers the agent before handing back its session.
		AgentRegistry.global().register({
			id: opts.agentId ?? "",
			displayName: opts.agentDisplayName ?? "fork",
			kind: "sub",
			parentId: opts.parentAgentId,
			session: fork.session as unknown as AgentSession,
			sessionFile: path.join(artifactsDir, `${opts.agentId}.jsonl`),
			status: "idle",
		});
		return { session: fork.session } as unknown as CreateAgentSessionResult;
	});
	const sends: { from: string; to: string; body: string; forkReport?: { done: boolean } }[] = [];
	vi.spyOn(IrcBus.global(), "send").mockImplementation(async message => {
		sends.push(message);
		return { to: message.to, outcome: "injected" };
	});
	return {
		tempDir,
		artifactsDir,
		ctx,
		forkSpy,
		getSessionFile,
		fork,
		sends,
		get options() {
			if (!options) throw new Error("createAgentSession was not called");
			return options;
		},
		handBack(): CustomTool {
			const tool = options?.customTools?.find(t => t.name === "hand_back");
			if (!tool) throw new Error("hand_back was not provided to the fork");
			return tool as CustomTool;
		},
	};
}

function forkIds(): string[] {
	return AgentRegistry.global()
		.list()
		.filter(ref => ref.id.startsWith("Fork-"))
		.map(ref => ref.id);
}

/** Resolves when `id` leaves the registry, which is where a fork's close is observable. */
function removed(id: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = AgentRegistry.global().onChange(event => {
		if (event.type === "removed" && event.ref.id === id) {
			unsubscribe();
			resolve();
		}
	});
	return promise;
}

describe("ForkCommandController", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("forks the transcript into the parent artifacts and sends the request to the fork, not the main chat", async () => {
		const h = createHarness();
		const controller = new ForkCommandController(h.ctx);

		await controller.start("check the flaky test");

		expect(h.forkSpy).toHaveBeenCalledWith(
			expect.any(String),
			h.tempDir.path(),
			h.artifactsDir,
			undefined,
			expect.objectContaining({ sessionFile: expect.stringMatching(/Fork-.+\.jsonl$/), copyArtifacts: false }),
		);
		const [forkId] = forkIds();
		expect(forkId).toBeDefined();
		expect(h.options.parentAgentId).toBe(MAIN_AGENT_ID);
		expect(h.options.agentDisplayName).toBe("check the flaky test");
		expect(h.fork.session.prompt).toHaveBeenCalledWith("check the flaky test", { attribution: "user" });
		expect(h.ctx.session.sendCustomMessage).not.toHaveBeenCalled();
		expect(h.ctx.focusAgentSession).not.toHaveBeenCalled();
		// The fork's role is persisted, so a revived fork still knows the main chat's work is not its own.
		expect(h.fork.persisted).toEqual([expect.objectContaining({ role: "developer" })]);
		expect(h.fork.agentMessages).toEqual([expect.objectContaining({ role: "developer" })]);
		expect(AgentLifecycleManager.global().has(forkId ?? "")).toBe(true);
	});

	it("opens a bare fork directly so the user can talk to it", async () => {
		const h = createHarness();
		const controller = new ForkCommandController(h.ctx);

		await controller.start("");

		const [forkId] = forkIds();
		expect(h.ctx.focusAgentSession).toHaveBeenCalledWith(forkId);
		expect(h.fork.session.prompt).not.toHaveBeenCalled();
	});

	it("posts an update to the main session and stays open", async () => {
		const h = createHarness();
		const controller = new ForkCommandController(h.ctx);
		await controller.start("investigate");
		const [forkId = ""] = forkIds();

		const result = await h.handBack().execute("call-1", { message: "Found the root cause" }, undefined, {} as never);

		expect(h.sends).toEqual([
			{ from: forkId, to: MAIN_AGENT_ID, body: "Found the root cause", forkReport: { done: false } },
		]);
		expect(result.details).toEqual({ delivered: true, done: false });
		expect(forkIds()).toEqual([forkId]);
		expect(controller.has(forkId)).toBe(true);
	});

	it("delivers the final report, lets the reporting turn finish, then closes the fork", async () => {
		const h = createHarness();
		const controller = new ForkCommandController(h.ctx);
		await controller.start("investigate");
		const [forkId = ""] = forkIds();
		h.fork.holdIdle();
		const closed = removed(forkId);

		await h.handBack().execute("call-1", { message: "Fixed it in foo.ts", done: true }, undefined, {} as never);

		expect(h.sends).toEqual([
			{ from: forkId, to: MAIN_AGENT_ID, body: "Fixed it in foo.ts", forkReport: { done: true } },
		]);
		// Still registered while the turn that called hand_back is finishing.
		expect(forkIds()).toEqual([forkId]);
		h.fork.finishTurn();
		await closed;
		expect(controller.has(forkId)).toBe(false);
		expect(h.fork.session.dispose).toHaveBeenCalled();
	});

	it("keeps the fork open when the main session cannot receive the report", async () => {
		const h = createHarness();
		const controller = new ForkCommandController(h.ctx);
		await controller.start("investigate");
		const [forkId = ""] = forkIds();
		vi.spyOn(IrcBus.global(), "send").mockResolvedValue({ to: MAIN_AGENT_ID, outcome: "failed", error: "gone" });

		const result = await h.handBack().execute("call-1", { message: "done", done: true }, undefined, {} as never);

		// A failed delivery never schedules the close.
		expect(result.details).toEqual({ delivered: false, done: true });
		expect(controller.has(forkId)).toBe(true);
		expect(forkIds()).toEqual([forkId]);
	});

	it("restores the fork notice after compaction", async () => {
		const h = createHarness();
		const controller = new ForkCommandController(h.ctx);
		await controller.start("investigate");

		h.fork.emit({ type: "auto_compaction_end", result: {}, aborted: false });

		expect(h.fork.agentMessages.filter(message => message.role === "developer")).toHaveLength(2);
	});

	it("closes an idle fork from the agents panel without a report", async () => {
		const h = createHarness();
		const controller = new ForkCommandController(h.ctx);
		await controller.start("investigate");
		const [forkId = ""] = forkIds();

		expect(await controller.close(forkId)).toBe(true);

		expect(forkIds()).toEqual([]);
		expect(h.sends).toEqual([]);
	});

	it("closes every fork when the main session changes", async () => {
		const h = createHarness();
		const controller = new ForkCommandController(h.ctx);
		await controller.start("one");

		await controller.dispose();

		expect(forkIds()).toEqual([]);
		expect(h.fork.session.dispose).toHaveBeenCalled();
	});

	it("refuses to fork an unsaved session", async () => {
		const h = createHarness();
		h.getSessionFile.mockReturnValue(undefined);
		const controller = new ForkCommandController(h.ctx);

		await controller.start("anything");

		expect(h.forkSpy).not.toHaveBeenCalled();
		expect(h.ctx.showError).toHaveBeenCalledWith("/fork requires a persisted session.");
	});
});

describe("ForkCommandController with a real child session", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		__resetDirsFromEnvForTests();
	});

	function bundled(id: string): Model {
		const found = getBundledModel("anthropic", id);
		if (!found) throw new Error(`Expected bundled anthropic/${id}`);
		return found;
	}

	/**
	 * Run `/fork` from a real main session that started on `transcriptModel`
	 * (its saved transcript model), has a different configured default role,
	 * and then switched live; return the real child session's state.
	 */
	async function forkFromLiveParent(
		settingsTier: "none" | "priority",
		switchLive: (parent: AgentSession, liveModel: Model) => Promise<void>,
	) {
		using tempDir = TempDir.createSync("@omp-fork-inheritance-");
		const cwd = tempDir.path();
		const agentDir = tempDir.join("agent");
		// The child session resolves agent-scoped state through the global agent dir.
		setAgentDir(agentDir);
		const transcriptModel = bundled("claude-haiku-4-5");
		const defaultRoleModel = bundled("claude-sonnet-4-5");
		const liveModel = bundled("claude-opus-4-5");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			defaultThinkingLevel: "low",
			"tier.anthropic": settingsTier,
			"task.enableLsp": false,
			"compaction.enabled": false,
		});
		settings.setModelRole("default", `${defaultRoleModel.provider}/${defaultRoleModel.id}`);
		const sessionManager = SessionManager.create(cwd, tempDir.join("sessions"));
		const { session: parent } = await sdkModule.createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager,
			model: transcriptModel,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
		});
		const focusAgentSession = vi.fn(async (_id: string) => {});
		const showError = vi.fn();
		const ctx = {
			session: parent,
			sessionManager,
			settings,
			showStatus: vi.fn(),
			showError,
			focusAgentSession,
		} as unknown as InteractiveModeContext;
		const controller = new ForkCommandController(ctx);
		try {
			await switchLive(parent, liveModel);
			await controller.start("");

			expect(showError).not.toHaveBeenCalled();
			const forkId = focusAgentSession.mock.calls[0]?.[0] ?? "";
			const child = AgentRegistry.global().get(forkId)?.session;
			if (!child) throw new Error("fork child session was not registered");
			expect(child).not.toBe(parent);
			return {
				liveModel: `${liveModel.provider}/${liveModel.id}`,
				model: `${child.model?.provider}/${child.model?.id}`,
				configuredThinkingLevel: child.configuredThinkingLevel(),
				thinkingLevel: child.thinkingLevel,
				serviceTierByFamily: { ...child.serviceTierByFamily },
			};
		} finally {
			await controller.dispose();
			await parent.dispose();
			authStorage.close();
		}
	}

	it("inherits the main chat's live model, effort, and raised tier over its transcript, default role, and settings", async () => {
		const child = await forkFromLiveParent("none", async (parent, liveModel) => {
			// An ephemeral switch (prewalk, retry fallback, context promotion) is the live
			// model a transcript restore skips: it would bring back the saved haiku entry.
			await parent.setModelTemporary(liveModel, Effort.High, { ephemeral: true });
			parent.setServiceTierFamily("anthropic", "priority");
		});

		expect(child.model).toBe(child.liveModel);
		expect(child.configuredThinkingLevel).toBe(Effort.High);
		expect(child.thinkingLevel).toBe(Effort.High);
		expect(child.serviceTierByFamily).toEqual({ anthropic: "priority" });
	}, 30_000);

	it("keeps a tier the main chat turned off even when settings still enable it", async () => {
		const child = await forkFromLiveParent("priority", async (parent, liveModel) => {
			await parent.setModelTemporary(liveModel, Effort.High, { ephemeral: true });
			expect(parent.serviceTierByFamily).toEqual({ anthropic: "priority" });
			parent.setServiceTierFamily("anthropic", undefined);
		});

		expect(child.model).toBe(child.liveModel);
		expect(child.serviceTierByFamily).toEqual({});
	}, 30_000);
});
