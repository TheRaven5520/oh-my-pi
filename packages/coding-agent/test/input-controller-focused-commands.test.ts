/**
 * Focused subagent views are chat-only, except for viewer-scoped commands: `/export`
 * writes the focused agent's own transcript (with its nested subagents) and `/usage`
 * reports account-wide limits. Everything else still requires returning to main.
 *
 * Failure mode if this regresses: `/export` and `/usage` silently do nothing in a
 * focused view, or `/export` writes the main session instead of the viewed one.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createFocusedContext() {
	let editorText = "";
	const editor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		setCollapsedText(text: string) {
			editorText = text;
		},
		composerChips() {
			return [];
		},
		addToHistory: vi.fn(),
		imageLinks: undefined,
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft: vi.fn(),
	};
	const prompt = vi.fn(async () => {});
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		session: {
			isStreaming: false,
			isCompacting: false,
			extensionRunner: undefined,
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
		},
		viewSession: { isStreaming: false, queuedMessageCount: 0, prompt, abort: vi.fn(async () => {}) },
		focusedAgentId: "Worker",
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		collabGuest: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		toggleUsagePinned: vi.fn(),
		setUsagePinned: vi.fn(),
		handleExportCommand: vi.fn(async () => {}),
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
	};
	return { ctx: ctx as unknown as InteractiveModeContext, raw: ctx, editor, prompt };
}

async function submit(text: string) {
	const focused = createFocusedContext();
	const controller = new InputController(focused.ctx);
	controller.setupEditorSubmitHandler();
	focused.editor.setText(text);
	await focused.ctx.editor.onSubmit?.(text);
	return focused;
}

describe("focused subagent view slash commands", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("toggles, pins, and clears the usage snapshot from the focused view", async () => {
		const toggled = await submit("/usage");
		expect(toggled.raw.toggleUsagePinned).toHaveBeenCalledTimes(1);
		expect(toggled.prompt).not.toHaveBeenCalled();

		const shown = await submit("/usage show");
		expect(shown.raw.setUsagePinned).toHaveBeenCalledWith(true);

		const cleared = await submit("/usage clear");
		expect(cleared.raw.setUsagePinned).toHaveBeenCalledWith(false);
		expect(cleared.prompt).not.toHaveBeenCalled();
	});

	it("runs /export with its arguments from the focused view", async () => {
		const { raw, prompt } = await submit("/export out.html");
		expect(raw.handleExportCommand).toHaveBeenCalledWith("/export out.html");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("keeps other commands gated to the main session, draft intact", async () => {
		const { raw, editor, prompt } = await submit("/compact");
		expect(raw.showStatus).toHaveBeenCalledWith(expect.stringContaining("press ←← to return first"));
		expect(editor.getText()).toBe("/compact");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("keeps unrecognized /usage forms gated to the main session", async () => {
		for (const text of ["/usage reset", "/usage reset anthropic/active"]) {
			const { raw, editor } = await submit(text);
			expect(raw.toggleUsagePinned).not.toHaveBeenCalled();
			expect(raw.setUsagePinned).not.toHaveBeenCalled();
			expect(raw.showStatus).toHaveBeenCalledWith(expect.stringContaining("press ←← to return first"));
			expect(editor.getText()).toBe(text);
		}
	});

	it("exports the viewed (focused) session rather than the main session", async () => {
		const mainExport = vi.fn(async () => "main.html");
		const viewExport = vi.fn(async () => "worker.html");
		const showStatus = vi.fn();
		const ctx = {
			session: { exportToHtml: mainExport },
			viewSession: { exportToHtml: viewExport },
			showStatus,
			showError: vi.fn(),
			showWarning: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		vi.spyOn(controller, "openInBrowser").mockImplementation(() => {});

		await controller.handleExportCommand("/export");

		expect(viewExport).toHaveBeenCalledTimes(1);
		expect(mainExport).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session exported to: worker.html");
	});
});
