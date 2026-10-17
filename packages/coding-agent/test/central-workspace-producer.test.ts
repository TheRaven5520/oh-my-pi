import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CentralPromptRejectedError } from "@oh-my-pi/pi-tui/apps/central/types";
import * as utils from "@oh-my-pi/pi-utils";
import { CentralSources, centralLines } from "../src/central/sources";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

describe("Central workspace producer through private IPC", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function fixture(responses: Array<() => MockResponse | Promise<MockResponse>>, providerSessionId?: string) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-central-producer-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
		const configRoot = spyOn(utils, "getBaseConfigRoot").mockReturnValue(root);
		cleanups.push(() => configRoot.mockRestore());
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		cleanups.push(() => auth.close());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ responses }).stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(auth),
			providerSessionId,
		});
		cleanups.push(() => session.dispose());
		let draft = "Unsent text in the original terminal";
		let editorWrites = 0;
		const dimensions: number[][] = [];
		const renderedSessions: Array<AgentSession | undefined> = [];
		const localFocus = { model: "Original model" };
		const errors: string[] = [];
		const editor = {
			getText: () => draft,
			setText(text: string) {
				editorWrites++;
				draft = text;
			},
		};
		session.setPromptDropped(prompt => editor.setText(prompt.text));
		const ctx = {
			session,
			editor,
			statusLine: {
				renderCentralWorkspace(statusWidth: number, usageWidth: number, sourceSession?: AgentSession) {
					dimensions.push([statusWidth, usageWidth]);
					renderedSessions.push(sourceSession);
					return {
						statusLines: [
							`\x1b[38;2;10;20;30m${sourceSession === session ? "Original model" : localFocus.model}\x1b[0m`,
						],
						usageLines: ["Codex 42%", "Claude 25%"],
					};
				},
			},
			ui: { requestRender() {} },
			updatePendingMessagesDisplay() {},
			syncComposerShape() {},
			setToolUIContext() {},
			showError: (error: string) => errors.push(error),
			showWarning: (error: string) => errors.push(error),
		} as unknown as InteractiveModeContext;
		const controller = new ExtensionUiController(ctx);
		await controller.initHooksAndCustomTools();
		const sources = new CentralSources();
		cleanups.push(() => sources.close());
		const snapshot = await sources.refresh();
		expect(snapshot.errors).toEqual([]);
		expect(snapshot.chats).toHaveLength(1);
		return {
			session,
			sources,
			chat: snapshot.chats[0]!,
			editor,
			dimensions,
			errors,
			renderedSessions,
			localFocus,
			editorWrites: () => editorWrites,
		};
	}

	it("requests the published main session while the local statusline displays a focused child", async () => {
		const f = await fixture([() => ({ content: ["Unused"] })]);
		f.localFocus.model = "Focused child model";
		const workspace = await f.sources.workspace(f.chat.id, 80, 24);
		expect(workspace.statusLines.map(line => Bun.stripANSI(line))).toEqual(["Original model"]);
		expect(f.renderedSessions).toEqual([f.session]);
		expect(f.localFocus.model).toBe("Focused child model");
		expect(f.session.messages).toEqual([]);
		expect(f.editorWrites()).toBe(0);
	});

	it("renders the source workspace read-only and sends plain text to that same existing session", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture([
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["Complete"] };
			},
		]);
		try {
			const sessionId = f.session.sessionManager.getSessionId();
			const before = f.session.sessionManager.getEntries().length;
			const workspace = await f.sources.workspace(f.chat.id, 80, 24);
			expect(workspace.canPrompt).toBe(true);
			expect(workspace.statusLines[0]).toContain("\x1b[38;2;10;20;30m");
			expect(workspace.usageLines.map(line => Bun.stripANSI(line))).toEqual(["Codex 42%", "Claude 25%"]);
			expect(f.dimensions).toEqual([[80, 24]]);
			expect(f.session.sessionManager.getEntries()).toHaveLength(before);
			await f.sources.prompt(f.chat.id, sessionId, "idle-send", "/new is plain text from Central");
			await utils.withTimeout(started.promise, 2_000, "Model did not start");
			expect(f.session.sessionId).toBe(sessionId);
			expect(f.session.isStreaming).toBe(true);
			await f.sources.prompt(f.chat.id, sessionId, "idle-send", "/new is plain text from Central");
			expect(f.editor.getText()).toBe("Unsent text in the original terminal");
			expect(f.editorWrites()).toBe(0);
		} finally {
			release.resolve();
			await f.session.waitForIdle();
		}
		const users = f.session.messages.filter(message => message.role === "user");
		expect(users).toHaveLength(1);
		expect(JSON.stringify(users[0]?.content)).toContain("/new is plain text from Central");
		expect(f.errors).toEqual([]);
	});

	it("queues exactly one steer while busy without changing the source draft", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture([
			async () => {
				started.resolve();
				await release.promise;
				return { content: ["First"] };
			},
			() => ({ content: ["Second"] }),
		]);
		const first = f.session.prompt("Original turn");
		try {
			await utils.withTimeout(started.promise, 2_000, "Original model did not start");
			await f.sources.prompt(f.chat.id, f.chat.sessionId, "busy-send", "Central steer");
			await f.sources.prompt(f.chat.id, f.chat.sessionId, "busy-send", "Central steer");
			expect(f.session.getQueuedMessages().steering).toEqual(["Central steer"]);
			expect(f.session.sessionId).toBe(f.chat.sessionId);
			expect(f.editor.getText()).toBe("Unsent text in the original terminal");
			expect(f.editorWrites()).toBe(0);
		} finally {
			release.resolve();
			await first;
			await f.session.waitForIdle();
		}
	});

	it("rejects missing credentials before accepting or persisting a Central prompt", async () => {
		let modelCalls = 0;
		const f = await fixture([
			() => {
				modelCalls++;
				return { content: ["Must not run"] };
			},
		]);
		const key = spyOn(f.session.modelRegistry, "getApiKey").mockResolvedValue(undefined);
		try {
			await expect(
				f.sources.prompt(f.chat.id, f.chat.sessionId, "missing-key", "Keep my draft"),
			).rejects.toBeInstanceOf(CentralPromptRejectedError);
			expect(f.session.messages.filter(message => message.role === "user")).toEqual([]);
			expect(modelCalls).toBe(0);
			expect(f.editorWrites()).toBe(0);
			expect(f.errors).toEqual([]);
		} finally {
			key.mockRestore();
		}
	});

	it("does not acknowledge a Central prompt aborted during pre-dispatch setup", async () => {
		let modelCalls = 0;
		const f = await fixture([
			() => {
				modelCalls++;
				return { content: ["Must not run"] };
			},
		]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const key = spyOn(f.session.modelRegistry, "getApiKey").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return "test-key";
		});
		let acknowledged = false;
		const outcome = f.sources.prompt(f.chat.id, f.chat.sessionId, "aborted-setup", "Keep my aborted draft").then(
			() => {
				acknowledged = true;
				return undefined;
			},
			(error: unknown) => error,
		);
		try {
			await utils.withTimeout(entered.promise, 2_000, "Prompt did not enter credential preflight");
			expect(acknowledged).toBe(false);
			const aborting = f.session.abort();
			release.resolve();
			await aborting;
			expect(await outcome).toBeInstanceOf(CentralPromptRejectedError);
			expect(acknowledged).toBe(false);
			expect(f.session.messages.filter(message => message.role === "user")).toEqual([]);
			expect(modelCalls).toBe(0);
			expect(f.editorWrites()).toBe(0);
		} finally {
			release.resolve();
			await outcome;
			key.mockRestore();
		}
	});

	it("only marks failures before admission as safe to submit with a fresh ID", async () => {
		const f = await fixture([() => ({ content: ["Must not run"] })]);
		let shouldAdmit = false;
		const prompt = spyOn(f.session, "prompt").mockImplementation(async (_text, options) => {
			options?.onPromptAdmitted?.();
			if (shouldAdmit) options?.onPromptAccepted?.();
			throw new Error(shouldAdmit ? "failure after admission" : "failure before admission");
		});
		try {
			await expect(f.sources.prompt(f.chat.id, f.chat.sessionId, "rejected", "hello")).rejects.toBeInstanceOf(
				CentralPromptRejectedError,
			);
			shouldAdmit = true;
			await f.sources.prompt(f.chat.id, f.chat.sessionId, "fresh-id", "hello");
			await f.sources.prompt(f.chat.id, f.chat.sessionId, "fresh-id", "hello");
			expect(prompt).toHaveBeenCalledTimes(2);
			expect(f.errors).toEqual(["Central prompt failed after admission: failure after admission"]);
			expect(f.editorWrites()).toBe(0);
		} finally {
			prompt.mockRestore();
		}
	});

	it.each(["fresh", "reset-context", "provider-override"] as const)(
		"accepts the original conversation after %s changes provider routing identity",
		async mode => {
			const f = await fixture(
				[() => ({ content: ["Accepted"] })],
				mode === "provider-override" ? "provider-only-id" : undefined,
			);
			if (mode === "fresh") expect(f.session.freshSession()).toBeDefined();
			if (mode === "reset-context") expect(await f.session.resetSessionContext()).toBeDefined();
			expect(f.session.sessionId).not.toBe(f.chat.sessionId);
			expect(f.session.sessionManager.getSessionId()).toBe(f.chat.sessionId);
			await f.sources.prompt(f.chat.id, f.chat.sessionId, "same-conversation", "Central conversation prompt");
			// Central acknowledges admission before provider preflight starts the
			// agent stream. waitForIdle alone can still observe that preflight as
			// idle; settle the admitted submission before checking persisted input.
			await f.session.waitForAdmittedSubmissions();
			await f.session.waitForIdle();
			expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
			expect(JSON.stringify(f.session.messages.find(message => message.role === "user")?.content)).toContain(
				"Central conversation prompt",
			);
			expect(f.session.sessionManager.getSessionId()).toBe(f.chat.sessionId);
			expect(f.editorWrites()).toBe(0);
			expect(f.errors).toEqual([]);
			await f.session.newSession();
			await expect(
				f.session.prompt("Old conversation", {
					expectedSessionId: f.chat.sessionId,
					restoreOnDrop: false,
				}),
			).rejects.toThrow("target session is no longer current");
			expect(f.session.messages.filter(message => message.role === "user")).toEqual([]);
		},
	);

	it("rejects stale-session sends through the live producer without starting a turn", async () => {
		const f = await fixture([() => ({ content: ["Must not run"] })]);
		await f.session.newSession();
		await expect(f.sources.prompt(f.chat.id, f.chat.sessionId, "stale-send", "Old target")).rejects.toThrow(
			"stale_session",
		);
		expect(f.session.messages.filter(message => message.role === "user")).toEqual([]);
		expect(f.editorWrites()).toBe(0);
	});
});

it("carries workspace and idempotent prompts through the real stdio-to-private-IPC bridge", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-central-stdio-"));
	const bridgePath = path.resolve(import.meta.dir, "../src/central/bridge.ts");
	const sourcesPath = path.resolve(import.meta.dir, "../src/central/sources.ts");
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
		import { startCentralHost, listCentralChats } from ${JSON.stringify(bridgePath)};
		import { serveCentralStdio } from ${JSON.stringify(sourcesPath)};
		let sent = 0;
		const host = await startCentralHost(
			() => ({ sessionId: "original", name: "Source", cwd: "/workspace", busy: false }),
			{
				getWorkspace: (statusWidth, usageWidth) => ({ statusLines: ["Sent " + sent], usageLines: [statusWidth + ":" + usageWidth], canPrompt: true }),
				prompt: async (sessionId, text) => {
					if (sessionId !== "original" || text !== "hello") throw new Error("Wrong target");
					sent++;
				},
			},
		);
		console.log(JSON.stringify({ chatId: (await listCentralChats())[0].id }));
		await serveCentralStdio();
		await host.close();
		`,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: root } },
	);
	try {
		const replies = centralLines(child.stdout);
		const ready = await utils.withTimeout(replies.next(), 10_000, "Stdio bridge did not start");
		const { chatId } = JSON.parse(ready.value!) as { chatId: string };
		const request = async (value: object): Promise<Record<string, unknown>> => {
			child.stdin.write(`${JSON.stringify(value)}\n`);
			await child.stdin.flush();
			const reply = await utils.withTimeout(replies.next(), 5_000, "Stdio bridge did not reply");
			return JSON.parse(reply.value!) as Record<string, unknown>;
		};
		const first = await request({ id: 1, op: "workspace", chatId, statusWidth: 80, usageWidth: 20 });
		expect(first).toMatchObject({ id: 1, workspace: { canPrompt: true } });
		for (const id of [2, 3]) {
			expect(
				await request({ id, op: "prompt", chatId, sessionId: "original", requestId: "same-send", text: "hello" }),
			).toEqual({ id, ok: true });
		}
		const workspace = (await request({ id: 4, op: "workspace", chatId, statusWidth: 80, usageWidth: 20 }))
			.workspace as { statusLines: string[]; usageLines: string[] };
		expect(workspace.statusLines.map(line => Bun.stripANSI(line))).toEqual(["Sent 1"]);
		expect(workspace.usageLines.map(line => Bun.stripANSI(line))).toEqual(["80:20"]);
		const rejected = await request({
			id: 5,
			op: "prompt",
			chatId,
			sessionId: "stale",
			requestId: "stale-send",
			text: "secret prompt body",
		});
		expect(rejected.error).toBeString();
		expect(rejected.confirmedNoAdmission).toBe(true);
		expect(JSON.stringify(rejected)).not.toContain("secret prompt body");
		child.stdin.end();
		expect(await utils.withTimeout(child.exited, 5_000, "Stdio bridge did not exit")).toBe(0);
	} finally {
		child.kill();
		await child.exited;
		await fs.rm(root, { recursive: true, force: true });
	}
});
