import { describe, expect, it, spyOn, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { ComposerDraftSnapshot } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";

function draft(text = ""): ComposerDraftSnapshot {
	return {
		version: 1,
		text,
		cursor: { line: 0, col: text.length },
		pastes: [],
		atoms: [],
		pasteCounter: 0,
		pendingImages: [],
		pendingImageLinks: [],
		imageLinks: null,
		pendingTexts: [],
		textAttachmentCounter: 0,
	};
}

function fixture(manager = SessionManager.inMemory("/draft-tests")) {
	let state = draft();
	const editor = {
		getText: () => state.text,
		awaitPendingPaste: async () => {},
		hasDraftContent: () => !!state.text || state.pendingImages.length > 0 || state.pendingTexts.length > 0,
		captureDraftSnapshot: () => structuredClone(state),
		restoreDraftSnapshot: (snapshot: ComposerDraftSnapshot) => {
			state = structuredClone(snapshot);
		},
	};
	const ctx = {
		sessionManager: manager,
		editor,
		focusedAgentId: undefined,
		ui: { hasOverlay: () => false, getFocused: () => editor, requestRender: vi.fn() },
		keybindings: new KeybindingsManager(),
		setHookWidget: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, controller: new InputController(ctx) };
}

function queued(manager: SessionManager): ComposerDraftSnapshot[] {
	const entry = manager
		.getEntries()
		.findLast(entry => entry.type === "custom" && entry.customType === "composer-draft-backlog");
	if (entry?.type !== "custom") return [];
	// Test fixtures create this known custom-entry payload above.
	const data = entry.data as { drafts: ComposerDraftSnapshot[] };
	return data.drafts;
}

describe("draft backlog failure boundaries", () => {
	it("saves attachment-only drafts rather than dequeuing over them", async () => {
		const f = fixture();
		const attached = draft();
		attached.pendingImages = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
		attached.pendingImageLinks = [null];
		f.editor.restoreDraftSnapshot(attached);
		await f.controller.handleDraftBacklog();
		expect(queued(f.ctx.sessionManager)).toEqual([attached]);
		await f.controller.handleDraftBacklog();
		expect(f.editor.captureDraftSnapshot()).toEqual(attached);
	});

	it("does not pop when the atomic transaction fails before restore", async () => {
		const f = fixture();
		f.editor.restoreDraftSnapshot(draft("retained"));
		await f.controller.handleDraftBacklog();
		const failure = spyOn(f.ctx.sessionManager, "appendEntriesAtomically").mockRejectedValue(new Error("disk full"));
		await f.controller.handleDraftBacklog();
		expect(queued(f.ctx.sessionManager).map(item => item.text)).toEqual(["retained"]);
		expect(f.editor.getText()).toBe("");
		failure.mockRestore();
	});

	it("abandons an operation if the session changes while pending paste finishes", async () => {
		const f = fixture();
		const original = f.ctx.sessionManager;
		f.editor.restoreDraftSnapshot(draft("original session"));
		f.editor.awaitPendingPaste = async () => {
			Object.assign(f.ctx, { sessionManager: SessionManager.inMemory("/other") });
		};
		await f.controller.handleDraftBacklog();
		expect(original.getEntries()).toEqual([]);
		expect(f.ctx.sessionManager.getEntries()).toEqual([]);
		expect(f.editor.getText()).toBe("original session");
	});
});

describe("composer draft backlog", () => {
	it("saves multiple drafts and restores FIFO without submitting provider messages", async () => {
		const f = fixture();
		for (const text of ["first", "second"]) {
			f.editor.restoreDraftSnapshot(draft(text));
			await f.controller.handleDraftBacklog();
			expect(f.editor.getText()).toBe("");
		}
		expect(queued(f.ctx.sessionManager).map(item => item.text)).toEqual(["first", "second"]);
		for (const text of ["first", "second"]) {
			await f.controller.handleDraftBacklog();
			expect(f.editor.getText()).toBe(text);
			f.editor.restoreDraftSnapshot(draft());
		}
		expect(f.ctx.sessionManager.buildSessionContext().messages).toEqual([]);
		expect(queued(f.ctx.sessionManager)).toEqual([]);
	});

	it("does nothing on empty composer and empty backlog", async () => {
		const f = fixture();
		await f.controller.handleDraftBacklog();
		expect(f.ctx.sessionManager.getEntries()).toEqual([]);
	});

	it("persists full snapshots across reopen and isolates other sessions", async () => {
		const storage = new MemorySessionStorage();
		const manager = SessionManager.create("/draft-tests", "/draft-sessions", storage);
		const f = fixture(manager);
		const snapshot = draft("[paste 1]");
		snapshot.atoms = [["[paste 1]", "expanded pasted content"]];
		snapshot.pendingTexts = [
			{ n: 1, label: "[paste 1]", content: "expanded pasted content", lineCount: 1, charCount: 23 },
		];
		snapshot.textAttachmentCounter = 1;
		f.editor.restoreDraftSnapshot(snapshot);
		await f.controller.handleDraftBacklog();
		const resumed = fixture(await SessionManager.open(manager.getSessionFile()!, "/draft-sessions", storage));
		resumed.controller.syncDraftBacklogIndicator();
		expect(resumed.ctx.setHookWidget).toHaveBeenCalledWith("composer-draft-backlog", [
			expect.stringContaining("1 saved draft"),
		]);
		await resumed.controller.handleDraftBacklog();
		expect(resumed.editor.captureDraftSnapshot()).toEqual(snapshot);
		const other = fixture(SessionManager.create("/draft-tests", "/draft-sessions", storage));
		await other.controller.handleDraftBacklog();
		expect(other.editor.getText()).toBe("");
	});

	it("keeps composer on failed enqueue and suppresses rapid duplicate operations", async () => {
		const f = fixture();
		f.editor.restoreDraftSnapshot(draft("keep me"));
		const fail = spyOn(f.ctx.sessionManager, "appendEntriesAtomically").mockRejectedValue(new Error("disk full"));
		await Promise.all([f.controller.handleDraftBacklog(), f.controller.handleDraftBacklog()]);
		expect(fail).toHaveBeenCalledTimes(1);
		expect(f.editor.getText()).toBe("keep me");
		expect(queued(f.ctx.sessionManager)).toEqual([]);
		expect(f.ctx.showError).toHaveBeenCalled();
		fail.mockRestore();
	});

	it("never overwrites edits arriving while persistence waits", async () => {
		const f = fixture();
		f.editor.restoreDraftSnapshot(draft("old"));
		const persist = f.ctx.sessionManager.appendEntriesAtomically.bind(f.ctx.sessionManager);
		const delayed = spyOn(f.ctx.sessionManager, "appendEntriesAtomically").mockImplementation(async append => {
			f.editor.restoreDraftSnapshot(draft("new typing"));
			return persist(append);
		});
		await f.controller.handleDraftBacklog();
		expect(f.editor.getText()).toBe("new typing");
		expect(queued(f.ctx.sessionManager)).toEqual([]);
		delayed.mockRestore();
	});

	it("defers to overlays and focused subagents", async () => {
		const f = fixture();
		f.editor.restoreDraftSnapshot(draft("untouched"));
		f.ctx.ui.hasOverlay = () => true;
		await f.controller.handleDraftBacklog();
		f.ctx.ui.hasOverlay = () => false;
		Object.assign(f.ctx, { focusedAgentId: "child" });
		await f.controller.handleDraftBacklog();
		expect(f.editor.getText()).toBe("untouched");
		expect(f.ctx.sessionManager.getEntries()).toEqual([]);
	});

	it("leaves malformed queue state untouched", async () => {
		const f = fixture();
		f.ctx.sessionManager.appendCustomEntry("composer-draft-backlog", {
			version: 1,
			sessionId: f.ctx.sessionManager.getSessionId(),
			drafts: [{}],
		});
		await f.controller.handleDraftBacklog();
		expect(f.editor.getText()).toBe("");
		expect(f.ctx.sessionManager.getEntries()).toHaveLength(1);
		expect(f.ctx.showError).toHaveBeenCalled();
	});
});
