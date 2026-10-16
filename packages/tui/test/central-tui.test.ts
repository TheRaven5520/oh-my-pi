import { beforeAll, describe, expect, it } from "bun:test";
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
