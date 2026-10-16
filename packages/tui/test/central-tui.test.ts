import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { TUI } from "../src/tui";
import { initTheme } from "../src/theme/theme";
import { CentralComponent } from "../src/apps/central/central-tui";
import type { CentralTuiHost } from "../src/apps/central/types";
import { VirtualTerminal } from "./virtual-terminal";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

describe("Central workspace scrolling", () => {
	it("routes a normal wheel report into the selected chat transcript", async () => {
		const terminal = new VirtualTerminal(100, 30);
		const scheduler = new VirtualRenderScheduler();
		const entries = Array.from({ length: 40 }, (_, index) => ({
			type: "message" as const,
			id: `message-${index}`,
			parentId: null,
			timestamp: new Date(index + 1).toISOString(),
			message: { role: "user" as const, content: `Central message ${index}`, timestamp: index + 1 },
		}));
		const otherEntries = Array.from({ length: 40 }, (_, index) => ({
			type: "message" as const,
			id: `other-${index}`,
			parentId: null,
			timestamp: new Date(index + 101).toISOString(),
			message: { role: "user" as const, content: `Other message ${index}`, timestamp: index + 101 },
		}));
		let revision = "40";
		const scheduledRefreshes: Array<() => void> = [];
		const originalSetTimeout = globalThis.setTimeout;
		const host: CentralTuiHost = {
			refresh: async () => ({
				chats: [
					{
						id: "local/chat",
						sessionId: "session",
						pid: 1,
						name: "Home chat",
						cwd: "/tmp",
						busy: false,
						transcriptRevision: revision,
						requests: [{ id: "question", createdAt: 1, kind: "editor", title: "Answer this" }],
					},
					{
						id: "local/other",
						sessionId: "other-session",
						pid: 2,
						name: "Other chat",
						cwd: "/tmp/other",
						busy: false,
						transcriptRevision: "4",
						requests: [],
					},
				],
				errors: [],
			}),
			transcript: async chatId => (chatId === "local/other" ? otherEntries : entries),
			answer: async () => {},
			open: async () => {},
		};
		const ui = new TUI(terminal, false, { renderScheduler: scheduler });
		const component = new CentralComponent(ui, host);
		const overlay = ui.showOverlay(component, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		ui.setFocus(component);
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			const [callback, delay] = args;
			if (delay === 1000 && typeof callback === "function") {
				scheduledRefreshes.push(() => callback());
				return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
			}
			return originalSetTimeout(...args);
		}) as typeof globalThis.setTimeout;
		try {
			void component.run();
			ui.start();
			await scheduler.settle(terminal);
			const before = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(before.join("\n")).toContain("Central message 39");
			expect(before.join("\n")).toContain("Answer this");
			terminal.sendInput("\x1b[<64;4;4M");
			await scheduler.settle(terminal);
			const after = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(after).not.toEqual(before);
			expect(after.join("\n")).not.toContain("Central message 39");
			expect(after.join("\n")).toContain("Answer this");
			expect(after.join("\n")).toContain("Central message");
			entries.push({
				type: "message",
				id: "message-40",
				parentId: null,
				timestamp: new Date(41).toISOString(),
				message: { role: "user", content: "Central message 40", timestamp: 41 },
			});
			revision = "41";
			const refresh = scheduledRefreshes.shift();
			expect(refresh).toBeDefined();
			refresh!();
			await Promise.resolve();
			await Promise.resolve();
			await scheduler.settle(terminal);
			const afterRevision = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(afterRevision).toEqual(after);
			for (let index = 0; index < 30; index++) terminal.sendInput("\x1b[<65;4;4M");
			await scheduler.settle(terminal);
			const atTail = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(atTail).toContain("Central message 40");
			terminal.sendInput("\x1b[<64;4;26M");
			await scheduler.settle(terminal);
			const afterQuestionWheel = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(afterQuestionWheel).toContain("Central message 40");
			terminal.sendInput("\t");
			await scheduler.settle(terminal);
			terminal.sendInput("\x1b[B");
			await scheduler.settle(terminal);
			await Promise.resolve();
			await scheduler.settle(terminal);
			const switched = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(switched).toContain("Other message 39");
			expect(switched).not.toContain("Other message 0");
			terminal.sendInput("\x1b[1;2A");
			await scheduler.settle(terminal);
			const shifted = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(shifted).not.toContain("Other message 39");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			component.dispose();
			overlay.hide();
			ui.stop();
		}
	});
	it("skips the manually selected chat rather than the queue head", async () => {
		const terminal = new VirtualTerminal(100, 24);
		const scheduler = new VirtualRenderScheduler();
		const chat = (id: string) => ({
			id,
			sessionId: id,
			pid: 1,
			name: id,
			cwd: "/tmp",
			busy: false,
			requests: [{ id: `question-${id}`, createdAt: 1, kind: "editor" as const, title: `Question ${id}` }],
		});
		const host: CentralTuiHost = {
			refresh: async () => ({ chats: [chat("a"), chat("b")], errors: [] }),
			transcript: async () => [],
			answer: async () => {},
			open: async () => {},
		};
		const ui = new TUI(terminal, false, { renderScheduler: scheduler });
		const component = new CentralComponent(ui, host);
		const overlay = ui.showOverlay(component, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		ui.setFocus(component);
		try {
			void component.run();
			ui.start();
			await scheduler.settle(terminal);
			terminal.sendInput("\t");
			await scheduler.settle(terminal);
			terminal.sendInput("\x1b[B");
			await scheduler.settle(terminal);
			expect(
				terminal
					.getViewport()
					.map(row => Bun.stripANSI(row))
					.join("\n"),
			).toContain("Question b");
			terminal.sendInput("\x1b");
			await scheduler.settle(terminal);
			const after = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(after).toContain("Question a");
			expect(after).not.toContain("Question b");
		} finally {
			component.dispose();
			overlay.hide();
			ui.stop();
		}
	});
});

describe("Central ask image prompts", () => {
	const image: ImageContent = { type: "image", data: "image-data", mimeType: "image/png" };

	async function setup(readPromptPaste: (path?: string) => Promise<{ text: string; images?: ImageContent[] }>, multi = false) {
		const terminal = new VirtualTerminal(100, 30);
		const scheduler = new VirtualRenderScheduler();
		const answer = vi.fn(async () => {});
		const host = {
			refresh: async () => ({
				chats: [{
					id: "local/chat", sessionId: "session", pid: 1, name: "Image chat", cwd: "/remote/chat",
					busy: false,
					requests: [{ id: "question", createdAt: 1, kind: "ask" as const,
						questions: [{ id: "q1", question: "Choose?", options: [{ label: "Option A" }], multi }],
					}],
				}], errors: [],
			}),
			transcript: async () => [], answer, open: async () => {}, readPromptPaste,
		};
		const ui = new TUI(terminal, false, { renderScheduler: scheduler });
		const component = new CentralComponent(ui, host);
		const overlay = ui.showOverlay(component, {
			anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true,
		});
		ui.setFocus(component);
		void component.run();
		ui.start();
		const settle = async () => { await scheduler.settle(terminal); };
		await settle();
		return {
			answer, settle,
			input: async (data: string) => { terminal.sendInput(data); await settle(); },
			text: () => terminal.getViewport().map(row => Bun.stripANSI(row)).join("\n"),
			close: () => { component.dispose(); overlay.hide(); ui.stop(); },
		};
	}

	for (const prompt of ["custom", "note"] as const) {
		for (const transport of ["clipboard", "path", "shortcut"] as const) {
			it(`keeps image-only ${prompt} answers from ${transport}, waiting for the pending paste`, async () => {
				const pending = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
				const load = vi.fn((_path?: string) => pending.promise);
				const rig = await setup(load);
				try {
					if (prompt === "custom") { await rig.input("\x1b[B"); await rig.input("\r"); }
					else await rig.input("n");
					expect(rig.text()).toContain(prompt === "custom" ? "Custom answer" : "Note for Option A");
					const paste = transport === "path" ? "\x1b[200~/tmp/screenshot.png\x1b[201~"
						: transport === "clipboard" ? "\x1b[200~\x1b[201~" : "\x16";
					await rig.input(paste);
					await rig.input("\r");
					expect(load).toHaveBeenCalledWith(transport === "path" ? "/tmp/screenshot.png" : undefined);
					expect(rig.answer).not.toHaveBeenCalled();
					pending.resolve({ text: "", images: [image] });
					await rig.settle();
					if (prompt === "note") await rig.input("\r");
					expect(rig.answer).toHaveBeenCalledTimes(1);
					expect(rig.answer.mock.calls[0]).toEqual([
						"local/chat", "question", expect.objectContaining({ kind: "submit", results: [
							expect.objectContaining(prompt === "custom"
								? { customInput: "[Image #1]", customInputImages: [image] }
								: { note: "[Image #1]", noteImages: [image] }),
						] }),
					]);
				} finally { rig.close(); }
			});
		}
	}

	it("preserves attachments when a custom answer is reopened", async () => {
		const rig = await setup(async () => ({ text: "", images: [image] }), true);
		try {
			await rig.input("\x1b[B");
			await rig.input("\r");
			await rig.input("\x1b[200~\x1b[201~");
			await rig.input("\r");
			await rig.input("\x1b[Z");
			await rig.input("\r");
			expect(rig.text()).toContain("[Image #1]");
			await rig.input("\r");
			await rig.input("\r");
			expect(rig.answer.mock.calls[0]).toEqual([
				"local/chat", "question", expect.objectContaining({ results: [
					expect.objectContaining({ customInput: "[Image #1]", customInputImages: [image] }),
				] }),
			]);
		} finally { rig.close(); }
	});

	it("reports failed image reads without submitting an empty answer", async () => {
		const pending = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
		const rig = await setup(() => pending.promise);
		try {
			await rig.input("\x1b[B"); await rig.input("\r");
			await rig.input("\x1b[200~/tmp/missing.png\x1b[201~\r");
			pending.reject(new Error("Image not found"));
			// Let the paste rejection handler enqueue its render before draining the virtual scheduler:
			// settle() returns immediately when no frame is queued at entry.
			await Promise.resolve();
			await rig.settle();
			expect(rig.answer).not.toHaveBeenCalled();
			expect(rig.text()).toContain("Image not found");
			expect(rig.text()).toContain("Custom answer");
		} finally { rig.close(); }
	});
	it("keeps quoted image paths in paste order when reads finish out of order", async () => {
		const first = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
		const second = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
		const other: ImageContent = { ...image, data: "second-image" };
		const load = vi.fn((path?: string) => path === "/tmp/first image.png" ? first.promise : second.promise);
		const rig = await setup(load);
		try {
			await rig.input("\x1b[B"); await rig.input("\r");
			await rig.input("\x1b[200~'/tmp/first image.png' /tmp/second.png\x1b[201~\r");
			expect(load.mock.calls).toEqual([["/tmp/first image.png"], ["/tmp/second.png"]]);
			second.resolve({ text: "", images: [other] });
			await rig.settle();
			expect(rig.answer).not.toHaveBeenCalled();
			first.resolve({ text: "", images: [image] });
			await rig.settle();
			expect(rig.answer.mock.calls[0]).toEqual([
				"local/chat", "question", expect.objectContaining({ results: [
					expect.objectContaining({ customInputImages: [image, other] }),
				] }),
			]);
		} finally { rig.close(); }
	});

	it("does not deliver a late image into a cancelled prompt or its replacement", async () => {
		const pending = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
		const rig = await setup(() => pending.promise);
		try {
			await rig.input("\x1b[B"); await rig.input("\r");
			await rig.input("\x1b[200~\x1b[201~");
			await rig.input("\x1b");
			await rig.input("\r");
			pending.resolve({ text: "", images: [image] });
			await rig.settle();
			expect(rig.text()).toContain("Custom answer");
			expect(rig.text()).not.toContain("[Image #1]");
			expect(rig.answer).not.toHaveBeenCalled();
			await rig.input("replacement"); await rig.input("\r");
			expect(rig.answer.mock.calls[0]).toEqual([
				"local/chat", "question", expect.objectContaining({ results: [
					expect.objectContaining({ customInput: "replacement", customInputImages: undefined }),
				] }),
			]);
		} finally { rig.close(); }
	});
});
