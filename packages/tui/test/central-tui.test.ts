import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { TranscriptEntryLike } from "../src/chat/transcript-entry";
import { TUI } from "../src/tui";
import { initTheme } from "../src/theme/theme";
import { CentralComponent } from "../src/apps/central/central-tui";
import type { CentralChat, CentralTuiHost, CentralWorkspace } from "../src/apps/central/types";
import { CentralPromptRejectedError } from "../src/apps/central/types";
import { AskDialogComponent } from "../src/overlays/ask-dialog";
import { VirtualTerminal } from "./virtual-terminal";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

describe("Central workspace scrolling", () => {
	it("cycles chats in both directions without moving drafts and opens a chat without a question", async () => {
		const terminal = new VirtualTerminal(110, 30);
		const scheduler = new VirtualRenderScheduler();
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const host: CentralTuiHost = {
			refresh: async () => ({
				chats: ["a", "b", "c"].map(id => ({
					id,
					sessionId: id,
					pid: 1,
					name: `Chat ${id}`,
					cwd: `/chat/${id}`,
					busy: false,
					requests:
						id === "c" ? [] : [{ id: `q-${id}`, createdAt: 1, kind: "editor" as const, title: `Question ${id}` }],
				})),
				errors: [],
			}),
			transcript: async id => [
				{
					type: "message",
					id,
					parentId: null,
					timestamp: new Date(1).toISOString(),
					message: { role: "user", content: `Transcript ${id}`, timestamp: 1 },
				},
			],
			answer,
			open: async id => {
				throw new Error(`Open target ${id} unavailable`);
			},
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
		const text = () =>
			terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.join("\n");
		const input = async (data: string) => {
			terminal.sendInput(data);
			await scheduler.settle(terminal);
		};
		try {
			void component.run();
			ui.start();
			await scheduler.settle(terminal);
			await input("draft-a");
			await input("\t");
			expect(text()).toContain("Transcript b");
			expect(text()).not.toContain("draft-a");
			await input("draft-b");
			await input("\t");
			expect(text()).toContain("Transcript c");
			await input("\x0f");
			expect(text()).toContain("Open target c unavailable");
			await input("\t");
			expect(text()).toContain("Transcript a");
			expect(text()).toContain("draft-a");
			expect(text()).not.toContain("draft-b");
			await input("\x1b[Z");
			expect(text()).toContain("Transcript c");
			await input("\x1b[Z");
			expect(text()).toContain("Transcript b");
			expect(text()).toContain("draft-b");
			expect(answer).not.toHaveBeenCalled();
			await input("\x11");
			expect(answer.mock.calls).toEqual([["b", "q-b", "draft-b"]]);
		} finally {
			component.dispose();
			overlay.hide();
			ui.stop();
		}
	});
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
	it("keeps the selected chat transcript fresh after a chat switch", async () => {
		const terminal = new VirtualTerminal(100, 24);
		const scheduler = new VirtualRenderScheduler();
		const first = Promise.withResolvers<TranscriptEntryLike[]>();
		const second = Promise.withResolvers<TranscriptEntryLike[]>();
		const chat = (id: string) => ({
			id,
			sessionId: id,
			pid: 1,
			name: `Chat ${id}`,
			cwd: "/tmp",
			busy: false,
			transcriptRevision: "1",
			requests: [{ id: `question-${id}`, createdAt: 1, kind: "editor" as const, title: `Question ${id}` }],
		});
		const host: CentralTuiHost = {
			refresh: async () => ({ chats: [chat("a"), chat("b")], errors: [] }),
			transcript: async id => (id === "a" ? first.promise : second.promise),
			answer: async () => {},
			open: async () => {},
		};
		const message = (id: string, text: string): TranscriptEntryLike[] => [
			{
				type: "message",
				id,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: text, timestamp: Date.now() },
			},
		];
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
			second.resolve(message("b-message", "Chat B transcript"));
			await Promise.resolve();
			await Promise.resolve();
			await scheduler.settle(terminal);
			let text = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(text).toContain("Chat b  ·  local  ·  /tmp");
			expect(text).toContain("Chat B transcript");
			first.resolve(message("a-message", "Stale Chat A transcript"));
			await Promise.resolve();
			await Promise.resolve();
			await scheduler.settle(terminal);
			text = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(text).toContain("Chat B transcript");
			expect(text).not.toContain("Stale Chat A transcript");
		} finally {
			component.dispose();
			overlay.hide();
			ui.stop();
		}
	});
	it("reserves transcript rows for a tall question", async () => {
		const terminal = new VirtualTerminal(100, 30);
		const scheduler = new VirtualRenderScheduler();
		const host: CentralTuiHost = {
			refresh: async () => ({
				chats: [
					{
						id: "local/tall",
						sessionId: "tall-session",
						pid: 1,
						name: "Tall question chat",
						cwd: "/tmp/tall",
						busy: false,
						requests: [
							{
								id: "tall-question",
								createdAt: 1,
								kind: "ask" as const,
								questions: [
									{
										id: "choice",
										question: "Choose an option",
										header: "Options",
										options: Array.from({ length: 20 }, (_, index) => ({
											label: `Option ${index}`,
											description: "A long description that makes this question tall",
											preview: "Preview text",
										})),
										recommended: 0,
									},
								],
							},
						],
					},
				],
				errors: [],
			}),
			transcript: async () =>
				Array.from({ length: 20 }, (_, index) => ({
					type: "message" as const,
					id: `history-${index}`,
					parentId: null,
					timestamp: new Date(index + 1).toISOString(),
					message: { role: "user" as const, content: `History row ${index}`, timestamp: index + 1 },
				})),
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
			const text = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(text).toContain("Tall question chat");
			expect(text).toContain("History row 19");
		} finally {
			component.dispose();
			overlay.hide();
			ui.stop();
		}
	});
});

describe("Central ask image prompts", () => {
	const image: ImageContent = { type: "image", data: "image-data", mimeType: "image/png" };

	async function setup(
		readPromptPaste: (path?: string) => Promise<{ text: string; images?: ImageContent[] }>,
		multi = false,
	) {
		const terminal = new VirtualTerminal(100, 30);
		const scheduler = new VirtualRenderScheduler();
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const host = {
			refresh: async () => ({
				chats: [
					{
						id: "local/chat",
						sessionId: "session",
						pid: 1,
						name: "Image chat",
						cwd: "/remote/chat",
						busy: false,
						requests: [
							{
								id: "question",
								createdAt: 1,
								kind: "ask" as const,
								questions: [{ id: "q1", question: "Choose?", options: [{ label: "Option A" }], multi }],
							},
						],
					},
				],
				errors: [],
			}),
			transcript: async () => [],
			answer,
			open: async () => {},
			readPromptPaste,
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
		void component.run();
		ui.start();
		const settle = async () => {
			await scheduler.settle(terminal);
		};
		await settle();
		return {
			answer,
			settle,
			input: async (data: string) => {
				terminal.sendInput(data);
				await settle();
			},
			text: () =>
				terminal
					.getViewport()
					.map(row => Bun.stripANSI(row))
					.join("\n"),
			close: () => {
				component.dispose();
				overlay.hide();
				ui.stop();
			},
		};
	}

	for (const prompt of ["custom", "note"] as const) {
		for (const transport of ["clipboard", "path", "shortcut"] as const) {
			it(`keeps image-only ${prompt} answers from ${transport}, waiting for the pending paste`, async () => {
				const pending = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
				const load = vi.fn((_path?: string) => pending.promise);
				const rig = await setup(load);
				try {
					if (prompt === "custom") {
						await rig.input("\x1b[B");
						await rig.input("\r");
					} else await rig.input("n");
					expect(rig.text()).toContain(prompt === "custom" ? "Custom answer" : "Note for Option A");
					const paste =
						transport === "path"
							? "\x1b[200~/tmp/screenshot.png\x1b[201~"
							: transport === "clipboard"
								? "\x1b[200~\x1b[201~"
								: "\x16";
					await rig.input(paste);
					await rig.input("\r");
					expect(load).toHaveBeenCalledWith(transport === "path" ? "/tmp/screenshot.png" : undefined);
					expect(rig.answer).not.toHaveBeenCalled();
					pending.resolve({ text: "", images: [image] });
					await rig.settle();
					if (prompt === "note") await rig.input("\r");
					expect(rig.answer).toHaveBeenCalledTimes(1);
					expect(rig.answer.mock.calls[0]).toEqual([
						"local/chat",
						"question",
						expect.objectContaining({
							kind: "submit",
							results: [
								expect.objectContaining(
									prompt === "custom"
										? { customInput: "[Image #1]", customInputImages: [image] }
										: { note: "[Image #1]", noteImages: [image] },
								),
							],
						}),
					]);
				} finally {
					rig.close();
				}
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
			await rig.input("\x1b[D");
			await rig.input("\r");
			expect(rig.text()).toContain("[Image #1]");
			await rig.input("\r");
			await rig.input("\r");
			expect(rig.answer.mock.calls[0]).toEqual([
				"local/chat",
				"question",
				expect.objectContaining({
					results: [expect.objectContaining({ customInput: "[Image #1]", customInputImages: [image] })],
				}),
			]);
		} finally {
			rig.close();
		}
	});

	it("reports failed image reads without submitting an empty answer", async () => {
		const pending = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
		const rig = await setup(() => pending.promise);
		try {
			await rig.input("\x1b[B");
			await rig.input("\r");
			await rig.input("\x1b[200~/tmp/missing.png\x1b[201~\r");
			pending.reject(new Error("Image not found"));
			// Let the paste rejection handler enqueue its render before draining the virtual scheduler:
			// settle() returns immediately when no frame is queued at entry.
			await Promise.resolve();
			await rig.settle();
			expect(rig.answer).not.toHaveBeenCalled();
			expect(rig.text()).toContain("Image not found");
			expect(rig.text()).toContain("Custom answer");
		} finally {
			rig.close();
		}
	});
	it("keeps quoted image paths in paste order when reads finish out of order", async () => {
		const first = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
		const second = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
		const other: ImageContent = { ...image, data: "second-image" };
		const load = vi.fn((path?: string) => (path === "/tmp/first image.png" ? first.promise : second.promise));
		const rig = await setup(load);
		try {
			await rig.input("\x1b[B");
			await rig.input("\r");
			await rig.input("\x1b[200~'/tmp/first image.png' /tmp/second.png\x1b[201~\r");
			expect(load.mock.calls).toEqual([["/tmp/first image.png"], ["/tmp/second.png"]]);
			second.resolve({ text: "", images: [other] });
			await rig.settle();
			expect(rig.answer).not.toHaveBeenCalled();
			first.resolve({ text: "", images: [image] });
			await rig.settle();
			expect(rig.answer.mock.calls[0]).toEqual([
				"local/chat",
				"question",
				expect.objectContaining({ results: [expect.objectContaining({ customInputImages: [image, other] })] }),
			]);
		} finally {
			rig.close();
		}
	});

	it("does not deliver a late image into a cancelled prompt or its replacement", async () => {
		const pending = Promise.withResolvers<{ text: string; images: ImageContent[] }>();
		const rig = await setup(() => pending.promise);
		try {
			await rig.input("\x1b[B");
			await rig.input("\r");
			await rig.input("\x1b[200~\x1b[201~");
			await rig.input("\x1b");
			await rig.input("\r");
			pending.resolve({ text: "", images: [image] });
			await rig.settle();
			expect(rig.text()).toContain("Custom answer");
			expect(rig.text()).not.toContain("[Image #1]");
			expect(rig.answer).not.toHaveBeenCalled();
			await rig.input("replacement");
			await rig.input("\r");
			expect(rig.answer.mock.calls[0]).toEqual([
				"local/chat",
				"question",
				expect.objectContaining({
					results: [expect.objectContaining({ customInput: "replacement", customInputImages: undefined })],
				}),
			]);
		} finally {
			rig.close();
		}
	});
});

describe("Central selected-chat workspace", () => {
	const chat = (id: string): CentralChat => ({
		id,
		sessionId: `session-${id}`,
		pid: 1,
		name: `Chat ${id}`,
		cwd: `/chat/${id}`,
		busy: false,
		requests: [],
	});
	const workspace = (id: string): CentralWorkspace => ({
		statusLines: [`\x1b[38;2;41;82;123mStatus ${id}\x1b[0m`],
		usageLines: [`\x1b[38;2;44;88;132mCodex ${id}\x1b[0m`, `\x1b[38;2;55;99;144mClaude ${id}\x1b[0m`],
		canPrompt: true,
	});
	const flush = async () => {
		for (let index = 0; index < 8; index++) await Promise.resolve();
	};
	async function setup(overrides: Partial<CentralTuiHost> = {}, width = 110, height = 24) {
		const terminal = new VirtualTerminal(width, height);
		const ui = new TUI(terminal, false, { renderScheduler: new VirtualRenderScheduler() });
		const host: CentralTuiHost = {
			refresh: async () => ({ chats: [chat("a"), chat("b")], errors: [] }),
			transcript: async id => [
				{
					type: "message",
					id,
					parentId: null,
					timestamp: new Date(1).toISOString(),
					message: { role: "user", content: `Transcript ${id}`, timestamp: 1 },
				},
			],
			answer: async () => {},
			open: async () => {},
			workspace: async id => workspace(id),
			prompt: async () => {},
			...overrides,
		};
		const component = new CentralComponent(ui, host);
		component.focused = true;
		component.render(width);
		void component.run();
		await flush();
		component.render(width);
		await flush();
		return {
			component,
			host,
			input: async (value: string) => {
				component.handleInput(value);
				await flush();
			},
			lines: () => component.render(width),
			text: () =>
				component
					.render(width)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
		};
	}

	it("shows an actionable old-peer state on Enter and keeps each draft", async () => {
		const prompt = vi.fn(async () => {});
		const rig = await setup({
			prompt,
			workspace: async () => {
				throw new Error("Unsupported workspace");
			},
		});
		try {
			await rig.input("keep old peer draft");
			await rig.input("\r");
			expect(prompt).not.toHaveBeenCalled();
			expect(rig.text()).toContain("Ctrl+O");
			expect(rig.text()).toContain("keep old peer draft");
			await rig.input("\t");
			expect(rig.text()).not.toContain("keep old peer draft");
			await rig.input("\t");
			expect(rig.text()).toContain("keep old peer draft");
		} finally {
			rig.component.dispose();
		}
	});

	it("focuses the normal band composer by mouse and sends through the fullscreen TUI", async () => {
		const terminal = new VirtualTerminal(110, 30);
		const scheduler = new VirtualRenderScheduler();
		const ui = new TUI(terminal, false, { renderScheduler: scheduler });
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {});
		const selected = chat("a");
		selected.requests = [{ id: "question", createdAt: 1, kind: "editor", title: "Answer separately" }];
		const component = new CentralComponent(ui, {
			refresh: async () => ({ chats: [selected], errors: [] }),
			transcript: async () => [],
			answer: async () => {},
			open: async () => {},
			prompt,
			workspace: async () => ({
				...workspace("a"),
				statusLines: [],
				composer: {
					shape: "band",
					topBorder: { content: "Source Claude status", width: 20 },
				},
			}),
		});
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
			const rows = terminal.getViewport().map(row => Bun.stripANSI(row));
			const statusRow = rows.findIndex(row => row.includes("Source Claude status"));
			expect(statusRow).toBeGreaterThanOrEqual(0);
			const composerRow = statusRow + 1;
			terminal.sendInput(`\x1b[<0;4;${composerRow + 1}M`);
			terminal.sendInput("typed in composer");
			terminal.sendInput("\r");
			await scheduler.settle(terminal);
			expect(prompt.mock.calls).toEqual([["a", "session-a", expect.any(String), "typed in composer"]]);
		} finally {
			component.dispose();
			overlay.hide();
			ui.stop();
		}
	});

	it("sends a bracketed paste followed by Enter in the same input frame", async () => {
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {});
		const rig = await setup({ prompt });
		try {
			const text = "  first\nsecond\n";
			await rig.input(`\x1b[200~${text}\x1b[201~\r`);
			expect(prompt.mock.calls).toEqual([["a", "session-a", expect.any(String), text]]);
		} finally {
			rig.component.dispose();
		}
	});

	it("routes Enter after the final frame of a split paste through Central", async () => {
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {});
		const rig = await setup({ prompt });
		try {
			await rig.input("\x1b[200~first\n");
			await rig.input("second\x1b[201~\r");
			expect(prompt.mock.calls[0]?.[3]).toBe("first\nsecond");
		} finally {
			rig.component.dispose();
		}
	});

	it("preserves multiline pasted text and whitespace exactly when sending", async () => {
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {});
		const rig = await setup({ prompt });
		try {
			const text = "  first line\n\n    second line\n";
			await rig.input(`\x1b[200~${text}\x1b[201~`);
			await rig.input("\t");
			await rig.input("\x1b[Z");
			await rig.input("\r");
			expect(prompt.mock.calls[0]).toEqual(["a", "session-a", expect.any(String), text]);
		} finally {
			rig.component.dispose();
		}
	});

	it("expands large pasted text rather than sending display placeholders", async () => {
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {});
		const rig = await setup({ prompt });
		try {
			const text = Array.from({ length: 20 }, (_, index) => `line ${index}: ${"body ".repeat(30)}`).join("\n");
			await rig.input(`\x1b[200~${text}\x1b[201~`);
			await rig.input("\r");
			expect(prompt.mock.calls[0]?.[3]).toBe(text);
		} finally {
			rig.component.dispose();
		}
	});

	it("inserts Shift+Enter newlines and sends only on plain Enter", async () => {
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {});
		const rig = await setup({ prompt });
		try {
			await rig.input("line one");
			await rig.input("\x1b[13;2u");
			await rig.input("line two");
			expect(prompt).not.toHaveBeenCalled();
			await rig.input("\r");
			expect(prompt.mock.calls[0]?.[3]).toBe("line one\nline two");
		} finally {
			rig.component.dispose();
		}
	});

	it("captures the original destination and preserves newer typing and another chat's draft", async () => {
		const pending = Promise.withResolvers<void>();
		const prompt = vi.fn((..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => pending.promise);
		const rig = await setup({ prompt });
		try {
			await rig.input("first");
			await rig.input("\r");
			expect(prompt.mock.calls[0]).toEqual(["a", "session-a", expect.any(String), "first"]);
			await rig.input(" newer");
			await rig.input("\t");
			await rig.input("other draft");
			pending.resolve();
			await flush();
			expect(rig.text()).toContain("other draft");
			await rig.input("\x1b[Z");
			expect(rig.text()).toContain("first newer");
			expect(prompt).toHaveBeenCalledTimes(1);
		} finally {
			rig.component.dispose();
		}
	});

	it("keeps definitively rejected text editable and uses a fresh ID for the next send", async () => {
		let attempts = 0;
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {
			if (++attempts === 1) throw new CentralPromptRejectedError("Session is changing");
		});
		const rig = await setup({ prompt });
		try {
			await rig.input("retained");
			await rig.input("\r");
			expect(rig.text()).toContain("Not sent");
			expect(rig.text()).toContain("retained");
			await rig.input(" edited");
			await rig.input("\r");
			expect(prompt).toHaveBeenCalledTimes(2);
			expect(prompt.mock.calls[1]?.[2]).not.toBe(prompt.mock.calls[0]?.[2]);
			expect(prompt.mock.calls[1]?.[3]).toBe("retained edited");
			expect(rig.text()).not.toContain("retained edited");
		} finally {
			rig.component.dispose();
		}
	});

	it("keeps every supported usage row accessible through scrolling", async () => {
		const rig = await setup(
			{
				workspace: async () => ({
					statusLines: ["Selected status"],
					canPrompt: true,
					usageLines: Array.from({ length: 64 }, (_, index) => `Window ${index + 1}`),
				}),
			},
			80,
			12,
		);
		try {
			expect(rig.text()).toContain("Window 1");
			for (let index = 0; index < 64; index++) await rig.input("\x1b[1;3B");
			expect(rig.text()).toContain("Window 64");
			expect(rig.text()).toContain("Transcript a");
		} finally {
			rig.component.dispose();
		}
	});

	it("requires explicit retry after uncertain delivery and reuses the original payload and ID", async () => {
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {
			if (prompt.mock.calls.length === 1) throw new Error("Disconnected");
		});
		const rig = await setup({ prompt });
		try {
			await rig.input("saved");
			await rig.input("\r");
			expect(rig.text()).toContain("Delivery unconfirmed");
			expect(rig.text()).toContain("Ctrl+R retry");
			await rig.input("\r");
			await rig.input(" edit");
			await rig.input("\r");
			expect(prompt).toHaveBeenCalledTimes(1);
			await rig.input("\x12");
			expect(prompt.mock.calls[1]).toEqual(prompt.mock.calls[0]);
			expect(rig.text()).toContain("saved edit");
		} finally {
			rig.component.dispose();
		}
	});

	it("clears an unchanged sent draft without touching a different chat", async () => {
		const rig = await setup();
		try {
			await rig.input("send only this");
			await rig.input("\r");
			expect(rig.text()).not.toContain("send only this");
			await rig.input("\t");
			await rig.input("keep b");
			await rig.input("\t");
			expect(rig.text()).not.toContain("keep b");
			await rig.input("\t");
			expect(rig.text()).toContain("keep b");
		} finally {
			rig.component.dispose();
		}
	});

	it("ignores late workspace responses after switching away and back", async () => {
		const requests: Array<{ id: string; pending: PromiseWithResolvers<CentralWorkspace> }> = [];
		const rig = await setup({
			workspace: id => {
				const pending = Promise.withResolvers<CentralWorkspace>();
				requests.push({ id, pending });
				return pending.promise;
			},
		});
		try {
			const original = requests[requests.length - 1]!;
			await rig.input("\t");
			const other = requests[requests.length - 1]!;
			await rig.input("\x1b[Z");
			const latest = requests[requests.length - 1]!;
			latest.pending.resolve(workspace("new a"));
			await flush();
			original.pending.resolve(workspace("old a"));
			other.pending.resolve(workspace("old b"));
			await flush();
			expect(rig.text()).toContain("Status new a");
			expect(rig.text()).not.toContain("Status old");
		} finally {
			rig.component.dispose();
		}
	});

	it("anchors status/input and unseparated gradient usage rows, including narrow layouts", async () => {
		for (const width of [140, 110, 80, 48]) {
			const rig = await setup({}, width, 16);
			try {
				await rig.input("visible draft");
				const lines = rig.lines();
				expect(lines).toHaveLength(16);
				expect(rig.text()).toContain("Transcript a");
				expect(rig.text()).toContain("Status a");
				expect(rig.text()).toContain("visible draft");
				expect(lines[14]).toContain("\x1b[38;2;44;88;132mCodex a");
				expect(lines[15]).toContain("\x1b[38;2;55;99;144mClaude a");
				expect(lines.every(line => Bun.stringWidth(line, { countAnsiEscapeCodes: false }) <= width)).toBe(true);
			} finally {
				rig.component.dispose();
			}
		}
	});

	it("keeps both providers reachable in short viewports without sacrificing the input", async () => {
		for (const width of [140, 80, 48]) {
			const rig = await setup(
				{
					workspace: async () => ({
						statusLines: ["Selected status"],
						canPrompt: true,
						usageLines: ["Codex", "5h 14%", "7d 28%", "Claude", "5h 35%", "7d 46%"],
					}),
				},
				width,
				12,
			);
			try {
				await rig.input("short draft");
				expect(rig.text()).toContain("Codex");
				expect(rig.text()).toContain("Alt+↑/↓ usage");
				for (let index = 0; index < 3; index++) {
					await rig.input("\x1b[1;3B");
					rig.lines();
				}
				expect(rig.text()).toContain("Claude");
				expect(rig.text()).toContain("short draft");
				expect(rig.text()).toContain("Transcript a");
			} finally {
				rig.component.dispose();
			}
		}
	});

	it("refreshes workspace after polling failures without losing Central drafts", async () => {
		const polls: Array<() => void> = [];
		const originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			const [callback, delay] = args;
			if (delay === 1000 && typeof callback === "function") {
				polls.push(() => callback());
				return 0 as unknown as NodeJS.Timeout;
			}
			return originalSetTimeout(...args);
		}) as typeof globalThis.setTimeout;
		let fail = false;
		let revision = "initial";
		let component: CentralComponent | undefined;
		try {
			const rig = await setup({
				refresh: async () => {
					if (fail) throw new Error("poll offline");
					return { chats: [chat("a"), chat("b")], errors: [] };
				},
				workspace: async () => workspace(revision),
			});
			component = rig.component;
			await rig.input("draft during failure");
			fail = true;
			revision = "updated";
			expect(polls.length).toBeGreaterThan(0);
			polls.shift()!();
			await flush();
			expect(rig.text()).toContain("poll offline");
			expect(rig.text()).toContain("Status updated");
			await rig.input("\t");
			await rig.input("\x1b[Z");
			expect(rig.text()).toContain("draft during failure");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			component?.dispose();
		}
	});

	it("strips terminal actions from host workspace rows without stripping gradient colors", async () => {
		const rig = await setup({
			workspace: async () => ({
				statusLines: ["\x1b[2J\x1b]0;hostile title\x07\x1b[38;2;10;20;30mSafe status\x1b[0m\nextra"],
				usageLines: ["\x1b[31mCodex\x1b[0m\x1b[H"],
				canPrompt: true,
			}),
		});
		try {
			const rows = rig.lines();
			expect(rows).toHaveLength(24);
			expect(rows.join("\n")).toContain("\x1b[38;2;10;20;30mSafe status");
			expect(rows.join("\n")).not.toContain("\x1b[2J");
			expect(rows.join("\n")).not.toContain("\x1b]0;");
			expect(rows.join("\n")).not.toContain("\x1b[H");
		} finally {
			rig.component.dispose();
		}
	});

	it("retains editable drafts for unavailable old peers without sending or fabricating usage", async () => {
		const rig = await setup({ workspace: undefined, prompt: undefined });
		try {
			await rig.input("offline draft");
			await rig.input("\r");
			await rig.input("\t");
			await rig.input("\x1b[Z");
			expect(rig.text()).toContain("offline draft");
			expect(rig.text()).toContain("Status unavailable");
			expect(rig.text()).toContain("Usage unavailable");
		} finally {
			rig.component.dispose();
		}
	});

	it("keeps an unmatched selector search editable and recovers with Backspace", async () => {
		const first = chat("a");
		first.requests = [
			{
				id: "searchable",
				createdAt: 1,
				kind: "select",
				title: "Search options",
				options: Array.from({ length: 11 }, (_, index) => `Option ${index}`),
			},
		];
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const rig = await setup({ refresh: async () => ({ chats: [first], errors: [] }), answer }, 48, 24);
		try {
			expect(rig.text()).toContain("Option 0");
			await rig.input("z");
			expect(rig.text()).toContain("No matching options");
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
			await rig.input("\x7f");
			expect(rig.text()).toContain("Option 0");
			await rig.input("\r");
			expect(answer.mock.calls[0]).toEqual(["a", "searchable", "Option 0"]);
		} finally {
			rig.component.dispose();
		}
	});

	for (const kind of ["editor", "select"] as const) {
		it(`reserves a visible ${kind} control before long narrow usage panels`, async () => {
			const first = chat("a");
			first.requests = [
				kind === "editor"
					? {
							id: "visible-control",
							createdAt: 1,
							kind,
							title: "Visible editor",
							prefill: "Visible editable text",
						}
					: {
							id: "visible-control",
							createdAt: 1,
							kind,
							title: "Visible selector",
							options: ["Visible selected choice"],
						},
			];
			const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
			const rig = await setup(
				{
					refresh: async () => ({ chats: [first], errors: [] }),
					answer,
					workspace: async () => ({
						statusLines: ["Selected status"],
						canPrompt: true,
						usageLines: Array.from({ length: 13 }, (_, index) => `Usage row ${index}`),
					}),
				},
				48,
				24,
			);
			try {
				expect(rig.text()).toContain(kind === "editor" ? "Visible editable text" : "Visible selected choice");
				await rig.input(kind === "editor" ? "\x11" : "\r");
				expect(answer).toHaveBeenCalledTimes(1);
			} finally {
				rig.component.dispose();
			}
		});

		it(`never submits a ${kind} when only its title is visible`, async () => {
			const first = chat("a");
			const title = Array.from({ length: 30 }, (_, index) => `Title detail ${index}`).join("\n");
			first.requests = [
				kind === "editor"
					? { id: "hidden-control", createdAt: 1, kind, title, prefill: "Hidden editable text" }
					: { id: "hidden-control", createdAt: 1, kind, title, options: ["Hidden selected choice"] },
			];
			const answer = vi.fn(async () => {});
			const rig = await setup({ refresh: async () => ({ chats: [first], errors: [] }), answer }, 48, 12);
			try {
				expect(rig.text()).toContain("Title detail");
				expect(rig.text()).not.toContain(kind === "editor" ? "Hidden editable text" : "Hidden selected choice");
				await rig.input("should not edit");
				await rig.input(kind === "editor" ? "\x11" : "\r");
				expect(answer).not.toHaveBeenCalled();
			} finally {
				rig.component.dispose();
			}
		});
	}

	it("keeps a pending question and selected option visible at 48 columns by 12 rows", async () => {
		const first = chat("a");
		first.requests = [
			{
				id: "visible-ask",
				createdAt: 1,
				kind: "ask",
				questions: [{ id: "q", question: "Visible question?", options: [{ label: "Visible choice" }] }],
			},
		];
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const rig = await setup(
			{
				refresh: async () => ({ chats: [first], errors: [] }),
				answer,
				workspace: async () => ({
					statusLines: ["Selected status"],
					canPrompt: true,
					usageLines: ["Codex", "5h 10%", "7d 20%", "Claude", "5h 30%", "7d 40%"],
				}),
			},
			48,
			12,
		);
		try {
			expect(rig.lines()).toHaveLength(12);
			expect(rig.text()).toContain("Visible question?");
			expect(rig.text()).toContain("Visible choice");
			expect(rig.text()).toContain("Selected status");
			await rig.input("\r");
			expect(answer).toHaveBeenCalledTimes(1);
			expect(answer.mock.calls[0]?.[1]).toBe("visible-ask");
		} finally {
			rig.component.dispose();
		}
	});

	it("does not answer a question when the terminal is too short to show it", async () => {
		const first = chat("a");
		first.requests = [
			{
				id: "hidden-ask",
				createdAt: 1,
				kind: "ask",
				questions: [{ id: "q", question: "Hidden question?", options: [{ label: "Do not accept invisibly" }] }],
			},
		];
		const answer = vi.fn(async () => {});
		const rig = await setup({ refresh: async () => ({ chats: [first], errors: [] }), answer }, 48, 5);
		try {
			rig.lines();
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
		} finally {
			rig.component.dispose();
		}
	});

	it("keeps question arrows and F2 input focus separate while Tab still switches chats", async () => {
		const first = chat("a");
		first.requests = [
			{
				id: "ask-a",
				createdAt: 1,
				kind: "ask",
				questions: [
					{ id: "one", question: "First question", options: [{ label: "One" }] },
					{ id: "two", question: "Second question", options: [{ label: "Two" }] },
				],
			},
		];
		const answer = vi.fn(async () => {});
		const prompt = vi.fn(async () => {});
		const rig = await setup({ refresh: async () => ({ chats: [first, chat("b")], errors: [] }), answer, prompt });
		try {
			expect(rig.text()).toContain("First question");
			await rig.input("\x1b[C");
			expect(rig.text()).toContain("Second question");
			await rig.input("\x1bOQ");
			await rig.input("separate composer");
			await rig.input("\t");
			expect(rig.text()).not.toContain("separate composer");
			await rig.input("\x1b[Z");
			expect(rig.text()).toContain("separate composer");
			await rig.input("\r");
			expect(prompt).toHaveBeenCalledTimes(1);
			expect(answer).not.toHaveBeenCalled();
		} finally {
			rig.component.dispose();
		}
	});

	it("suppresses reserved Tab and expansion hints at the question renderer source", () => {
		const dialog = new AskDialogComponent(
			[
				{ id: "one", question: "Long question ".repeat(100), options: [{ label: "One" }] },
				{ id: "two", question: "Second", options: [{ label: "Two" }] },
			],
			{ onSubmit: () => {}, onCancel: () => {}, onPrompt: async () => undefined },
			{ showTabHint: false, showExpandHint: false },
		);
		try {
			const text = dialog
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n")
				.toLowerCase();
			expect(text).not.toContain("tab");
			expect(text).not.toContain("ctrl+o");
			dialog.handleInput("\x1b[C");
			expect(
				dialog
					.render(100)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
			).toContain("Second");
		} finally {
			dialog.dispose();
		}
	});
});

describe("Central restart onto a new build", () => {
	const question: CentralChat = {
		id: "local/q",
		sessionId: "q",
		pid: 1,
		name: "Asking",
		cwd: "/q",
		busy: false,
		requests: [{ id: "question", createdAt: 1, kind: "editor", title: "Answer me" }],
	};
	const plain: CentralChat = { ...question, id: "local/p", sessionId: "p", name: "Plain", requests: [] };
	const flush = async () => {
		for (let index = 0; index < 8; index++) await Promise.resolve();
	};

	async function setup(chats: CentralChat[]) {
		vi.useFakeTimers();
		let now = 0;
		let ready = false;
		const ui = new TUI(new VirtualTerminal(110, 30), false, { renderScheduler: new VirtualRenderScheduler() });
		const component = new CentralComponent(
			ui,
			{
				refresh: async () => ({ chats, errors: [] }),
				transcript: async () => [],
				answer: async () => {},
				open: async () => {},
				workspace: async () => ({ statusLines: [], usageLines: [], canPrompt: true }),
				prompt: async () => {},
			},
			{ restartReady: () => ready, quietMs: 60_000, now: () => now },
		);
		component.focused = true;
		let exit: string | undefined;
		void component.run().then(value => (exit = value));
		await flush();
		component.render(110);
		await flush();
		/** Advance one poll (1 s) at a time; returns the exit once Central has stopped. */
		const poll = async (ms: number) => {
			for (let elapsed = 0; elapsed < ms && exit === undefined; elapsed += 1_000) {
				now += 1_000;
				vi.advanceTimersByTime(1_000);
				await flush();
			}
			return exit;
		};
		return {
			component,
			poll,
			install: () => (ready = true),
			input: async (data: string) => {
				component.render(110);
				component.handleInput(data);
				await flush();
			},
		};
	}

	it("restarts once a build is ready and input has been quiet, never before", async () => {
		const rig = await setup([plain]);
		try {
			expect(await rig.poll(120_000)).toBeUndefined();
			rig.install();
			await rig.input("x");
			await rig.input("\x7f");
			// Typing restarts the quiet period.
			expect(await rig.poll(55_000)).toBeUndefined();
			expect(await rig.poll(10_000)).toBe("restart");
		} finally {
			rig.component.dispose();
			vi.useRealTimers();
		}
	});

	it("waits while a message draft or a started answer would be lost", async () => {
		const rig = await setup([question]);
		try {
			rig.install();
			await rig.input("half an answer");
			expect(await rig.poll(180_000)).toBeUndefined();
		} finally {
			rig.component.dispose();
			vi.useRealTimers();
		}
		const drafted = await setup([plain]);
		try {
			drafted.install();
			await drafted.input("unsent message");
			expect(await drafted.poll(180_000)).toBeUndefined();
			for (let index = 0; index < "unsent message".length; index++) await drafted.input("\x7f");
			expect(await drafted.poll(65_000)).toBe("restart");
		} finally {
			drafted.component.dispose();
			vi.useRealTimers();
		}
	});

	it("closes normally on Ctrl+C", async () => {
		const rig = await setup([plain]);
		try {
			await rig.input("\x03");
			expect(await rig.poll(1_000)).toBe("closed");
		} finally {
			rig.component.dispose();
			vi.useRealTimers();
		}
	});
});
