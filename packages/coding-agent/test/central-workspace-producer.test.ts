import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { CentralRequestDraft } from "@oh-my-pi/pi-tui/apps/central/types";
import { CentralPromptRejectedError } from "@oh-my-pi/pi-tui/apps/central/types";
import type { ExtensionAskDialogSubmitResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { type Component, Container, type OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import * as utils from "@oh-my-pi/pi-utils";
import { startCentralHost } from "../src/central/bridge";
import { CentralSources, centralLines } from "../src/central/sources";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { cfgDisplayToolState } from "../src/modes/settings";

beforeAll(async () => {
	await initTheme();
});

describe("Central workspace producer through private IPC", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function fixture(
		responses: Array<() => MockResponse | Promise<MockResponse>>,
		providerSessionId?: string,
		tools: AgentTool[] = [],
	) {
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
			initialState: { model, systemPrompt: ["Test"], tools },
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
			getBorderStyle: () => "band",
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
				renderCentralWorkspace(
					statusWidth: number,
					usageWidth: number,
					sourceSession?: AgentSession,
					shape?: string,
				) {
					dimensions.push([statusWidth, usageWidth]);
					renderedSessions.push(sourceSession);
					return {
						composer: { shape: shape ?? "box", topBorder: { content: "Source status", width: 13 } },
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
			centralCommands: () => [],
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
		expect(workspace.composer?.shape).toBe("band");
		expect(Bun.stripANSI(workspace.composer!.topBorder.content)).toBe("Source status");
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

	it("queues a Central prompt sent while an ask is open as a steer that the ask never consumes", async () => {
		const question: CentralRequestDraft = {
			kind: "ask",
			questions: [{ id: "pick", question: "FOCUS TEST", options: [{ label: "One" }, { label: "Two" }] }],
		};
		const picked: ExtensionAskDialogSubmitResult = {
			kind: "submit",
			results: [
				{ id: "pick", question: "FOCUS TEST", options: ["One", "Two"], multi: false, selectedOptions: ["Two"] },
			],
		};
		const asking = Promise.withResolvers<void>();
		const answers: unknown[] = [];
		// The same race the controller's ask dialog uses: a local dialog that stays open until answered.
		const ask: AgentTool = {
			name: "ask",
			label: "ask",
			description: "Ask the user",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				const host = await startCentralHost(() => {
					throw new Error("The controller already published this process");
				});
				const answer = host.race(question, signal, local => {
					const open = Promise.withResolvers<undefined>();
					local.addEventListener("abort", () => open.resolve(undefined), { once: true });
					return open.promise;
				});
				asking.resolve();
				const result = await answer;
				answers.push(result);
				return { content: [{ type: "text", text: `answered ${JSON.stringify(result)}` }], details: {} };
			},
		};
		const f = await fixture(
			[() => ({ content: [{ type: "toolCall", name: "ask", arguments: {} }] }), () => ({ content: ["Done"] })],
			undefined,
			[ask],
		);
		const run = f.session.prompt("Start");
		try {
			await utils.withTimeout(asking.promise, 2_000, "Ask did not open");
			const open = (await f.sources.refresh()).chats[0]!;
			expect(open.requests).toHaveLength(1);
			const steer = "[FOCUS: Shreyan says] steer while the ask is open";
			await f.sources.prompt(open.id, open.sessionId, "steer-during-ask", steer);
			expect(f.session.getQueuedMessages().steering).toEqual([steer]);
			// The ask is still open and unanswered: the steer did not feed or cancel it.
			const still = (await f.sources.refresh()).chats[0]!;
			expect(still.requests.map(request => request.id)).toEqual(open.requests.map(request => request.id));
			expect(answers).toEqual([]);
			await f.sources.answer(open.id, open.requests[0]!.id, picked);
		} finally {
			await run;
			await f.session.waitForIdle();
		}
		expect(answers).toEqual([picked]);
		const toolResult = f.session.messages.findIndex(message => message.role === "toolResult");
		const delivered = f.session.messages.findIndex(
			message => message.role === "user" && JSON.stringify(message.content).includes("steer while the ask is open"),
		);
		expect(JSON.stringify(f.session.messages[toolResult])).toContain("Two");
		expect(JSON.stringify(f.session.messages[toolResult])).not.toContain("steer while the ask is open");
		expect(delivered).toBeGreaterThan(toolResult);
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

describe("Central slash commands through private IPC and the composer's submit path", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	/** A real session, editor, TUI and InputController submit path; only the chat chrome is stubbed. */
	async function commandFixture() {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-central-command-"));
		cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
		const configRoot = spyOn(utils, "getBaseConfigRoot").mockReturnValue(root);
		cleanups.push(() => configRoot.mockRestore());
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		cleanups.push(() => auth.close());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: createMockModel({ responses: [() => ({ content: ["Must not run"] })] }).stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth),
		});
		cleanups.push(() => session.dispose());
		const ui = new TUI(new VirtualTerminal(100, 30), false, { renderScheduler: new VirtualRenderScheduler() });
		const editor = new CustomEditor(getEditorTheme());
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		const shown: string[] = [];
		const listeners = new Set<(message: string) => void>();
		const notice = (message: string): void => {
			shown.push(message);
			for (const listener of listeners) listener(message);
		};
		/** Stands in for the model picker: a real overlay that Escape dismisses, as pickers do. */
		class Picker implements Component {
			escapes = 0;
			handle: OverlayHandle | undefined;
			render(): string[] {
				return ["PICK A MODEL"];
			}
			handleInput(data: string): void {
				if (data !== "\x1b") return;
				this.escapes++;
				this.handle?.hide();
			}
			invalidate(): void {}
		}
		const pickers: Picker[] = [];
		const ctx = {
			session,
			viewSession: session,
			sessionManager: session.sessionManager,
			settings,
			editor,
			editorContainer,
			ui,
			toolDisplayState: "claude",
			toolOutputExpanded: false,
			chatContainer: Object.assign(new Container(), {
				setToolDisplayState() {},
				resetStableEmission() {},
			}),
			pendingMessagesContainer: new Container(),
			skillCommands: new Map(),
			fileSlashCommands: new Set<string>(),
			locallySubmittedUserSignatures: new Set<string>(),
			statusLine: {
				renderCentralWorkspace: () => ({ statusLines: ["Source"], usageLines: [] }),
			},
			updatePendingMessagesDisplay() {},
			syncComposerShape() {},
			setToolUIContext() {},
			showStatus: notice,
			showWarning: notice,
			showError: notice,
			observeNotices(listener: (message: string) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			centralCommands: () => [
				{ name: "state", description: "Set tool display" },
				{ name: "model", aliases: ["models"], description: "Switch model" },
			],
			runCentralCommand: (text: string, centralQuestionOpen: () => boolean) =>
				input.runCentralCommand(text, centralQuestionOpen),
			setToolDisplayState: (state: "hidden" | "claude" | "verbose") => input.setToolDisplayState(state),
			showModelSelector() {
				const picker = new Picker();
				picker.handle = ui.showOverlay(picker);
				pickers.push(picker);
			},
		} as unknown as InteractiveModeContext;
		const input = new InputController(ctx);
		input.setupEditorSubmitHandler();
		const controller = new ExtensionUiController(ctx);
		await controller.initHooksAndCustomTools();
		cleanups.push(() => controller.disposeCentral());
		const sources = new CentralSources();
		cleanups.push(() => sources.close());
		const snapshot = await sources.refresh();
		expect(snapshot.chats).toHaveLength(1);
		return { ctx, session, sources, chat: snapshot.chats[0]!, editor, ui, shown, pickers };
	}

	it("runs a builtin through the submit path, never as a prompt, and advertises the command list", async () => {
		const f = await commandFixture();
		f.editor.setText("draft typed in the chat");
		const workspace = await f.sources.workspace(f.chat.id, 80, 24);
		expect(workspace.canCommand).toBe(true);
		expect(workspace.commands?.map(command => command.name)).toEqual(["state", "model"]);
		const result = await f.sources.command(f.chat.id, f.chat.sessionId, "state-1", "/state verbose");
		expect(result).toBe("Tool display: verbose");
		expect(f.ctx.toolDisplayState).toBe("verbose");
		expect(cfgDisplayToolState.get(f.ctx.settings)).toBe("verbose");
		// Same request ID: the first run's result, not a second run.
		expect(await f.sources.command(f.chat.id, f.chat.sessionId, "state-1", "/state verbose")).toBe(
			"Tool display: verbose",
		);
		expect(f.shown).toEqual(["Tool display: verbose"]);
		expect(f.session.getQueuedMessages().steering).toEqual([]);
		expect(f.session.messages).toEqual([]);
		expect(f.editor.getText()).toBe("draft typed in the chat");
		// The request ID belongs to the command; reusing it for a prompt is a conflict.
		await expect(f.sources.prompt(f.chat.id, f.chat.sessionId, "state-1", "/state verbose")).rejects.toThrow(
			"request_id_conflict",
		);
		await expect(f.sources.command(f.chat.id, "another-session", "stale-1", "/state hidden")).rejects.toBeInstanceOf(
			CentralPromptRejectedError,
		);
		expect(f.ctx.toolDisplayState).toBe("verbose");
		expect(await f.sources.command(f.chat.id, f.chat.sessionId, "unknown-1", "/no-such-command")).toBe(
			"Not run: Unknown command /no-such-command in this chat; nothing was run",
		);
		expect(f.session.messages).toEqual([]);
	});

	it("closes a picker the command opened and leaves the chat window on its editor", async () => {
		const f = await commandFixture();
		const overlays = f.ui.overlayStack.length;
		const result = await f.sources.command(f.chat.id, f.chat.sessionId, "model-1", "/model");
		expect(result).toBe(
			"opens a picker in the chat's own window; give an argument (e.g. /model <name>) or use the chat",
		);
		expect(f.pickers).toHaveLength(1);
		expect(f.pickers[0]!.escapes).toBe(1);
		expect(f.ui.overlayStack).toHaveLength(overlays);
		expect(f.ui.getFocused()).toBe(f.editor);
		expect(f.session.messages).toEqual([]);
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
		let ran = 0;
		const host = await startCentralHost(
			() => ({ sessionId: "original", name: "Source", cwd: "/workspace", busy: false }),
			{
				getWorkspace: (statusWidth, usageWidth) => ({ statusLines: ["Sent " + sent + " Ran " + ran], usageLines: [statusWidth + ":" + usageWidth], canPrompt: true, canCommand: true, commands: [{ name: "state" }] }),
				prompt: async (sessionId, text) => {
					if (sessionId !== "original" || text !== "hello") throw new Error("Wrong target");
					sent++;
				},
				command: async (sessionId, text) => {
					if (sessionId !== "original" || text !== "/state verbose") throw new Error("Wrong target");
					ran++;
					return "Tool display: verbose";
				},
			},
		);
		console.log(JSON.stringify({ chatId: (await listCentralChats()).chats[0].id }));
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
		expect(first).toMatchObject({
			id: 1,
			workspace: { canPrompt: true, canCommand: true, commands: [{ name: "state" }] },
		});
		for (const id of [2, 3]) {
			expect(
				await request({ id, op: "prompt", chatId, sessionId: "original", requestId: "same-send", text: "hello" }),
			).toEqual({ id, ok: true });
		}
		for (const id of [20, 21]) {
			expect(
				await request({
					id,
					op: "command",
					chatId,
					sessionId: "original",
					requestId: "cmd",
					text: "/state verbose",
				}),
			).toEqual({ id, ok: true, result: "Tool display: verbose" });
		}
		const workspace = (await request({ id: 4, op: "workspace", chatId, statusWidth: 80, usageWidth: 20 }))
			.workspace as { statusLines: string[]; usageLines: string[] };
		expect(workspace.statusLines.map(line => Bun.stripANSI(line))).toEqual(["Sent 1 Ran 1"]);
		expect(
			await request({ id: 22, op: "command", chatId, sessionId: "original", requestId: "cmd2", text: "plain text" }),
		).toMatchObject({ id: 22, confirmedNoAdmission: true });
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

it("reports an unresponsive chat over the stdio bridge only to clients that request partial lists", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-central-stdio-partial-"));
	const bridgePath = path.resolve(import.meta.dir, "../src/central/bridge.ts");
	const sourcesPath = path.resolve(import.meta.dir, "../src/central/sources.ts");
	const env: Record<string, string | undefined> = { ...process.env, HOME: root };
	delete env.PI_CONFIG_DIR;
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
		import { startCentralHost } from ${JSON.stringify(bridgePath)};
		import { serveCentralStdio } from ${JSON.stringify(sourcesPath)};
		const host = await startCentralHost(() => ({ sessionId: "healthy", name: "Healthy", cwd: "/workspace", busy: false }));
		console.log("ready");
		await serveCentralStdio();
		await host.close();
		`,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
	);
	// Accepts and never replies, like a chat whose event loop is starved.
	const held = new Set<net.Socket>();
	const server = net.createServer(socket => held.add(socket));
	try {
		const replies = centralLines(child.stdout);
		await utils.withTimeout(replies.next(), 10_000, "Stdio bridge did not start");
		const dir = path.join(root, ".omp", "run", "central-hosts");
		const stuckId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
		const endpoint = path.join(root, "stuck.sock");
		await new Promise<void>(resolve => server.listen(endpoint, resolve));
		await fs.writeFile(
			path.join(dir, `${stuckId}.json`),
			JSON.stringify({ v: 1, id: stuckId, pid: process.pid, endpoint, token: "a".repeat(64) }),
			{ mode: 0o600 },
		);
		const request = async (value: object): Promise<Record<string, unknown>> => {
			child.stdin.write(`${JSON.stringify(value)}\n`);
			await child.stdin.flush();
			const reply = await utils.withTimeout(replies.next(), 5_000, "Stdio bridge did not reply");
			return JSON.parse(reply.value!) as Record<string, unknown>;
		};
		// An older client would read the missing chat as withdrawn, so it still gets a host-wide error.
		const legacy = await request({ id: 1, op: "list" });
		expect(legacy.error).toBeString();
		expect(legacy.chats).toBeUndefined();
		const partial = await request({ id: 2, op: "list", partial: true });
		expect((partial.chats as { name: string }[]).map(chat => chat.name)).toEqual(["Healthy"]);
		expect(partial.unresponsive).toEqual([{ id: stuckId, error: "host_timeout" }]);
		child.stdin.end();
		expect(await utils.withTimeout(child.exited, 5_000, "Stdio bridge did not exit")).toBe(0);
	} finally {
		for (const socket of held) socket.destroy();
		server.close();
		child.kill();
		await child.exited;
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
