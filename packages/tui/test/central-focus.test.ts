import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { TranscriptEntryLike } from "../src/chat/transcript-entry";
import { TUI } from "../src/tui";
import { initTheme } from "../src/theme/theme";
import { CentralComponent } from "../src/apps/central/central-tui";
import { focusTranscriptEntries, parseFocusCommand, resolveFocusTarget } from "../src/apps/central/focus";
import type { CentralChat, CentralFocusCommands, CentralSnapshot, CentralTuiHost } from "../src/apps/central/types";
import { VirtualTerminal } from "./virtual-terminal";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

const PREFIX = "[FOCUS: Shreyan says] ";

function assistant(id: string, content: unknown[]): TranscriptEntryLike {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		} as never,
	};
}

const mixedTranscript: TranscriptEntryLike[] = [
	{
		type: "message",
		id: "u",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "USER-SECRET", timestamp: 1 },
	},
	assistant("a1", [
		{ type: "thinking", thinking: "THINK-SECRET" },
		{ type: "text", text: "REPLY-ONE" },
		{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "TOOLCALL-SECRET" } },
	]),
	{
		type: "message",
		id: "r",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "RESULT-SECRET" }],
			isError: false,
			timestamp: 1,
		},
	} as TranscriptEntryLike,
	{
		type: "custom_message",
		id: "c",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		customType: "notice",
		content: "CUSTOM-SECRET",
		display: true,
	},
	assistant("a2", [{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "ONLY-TOOL-SECRET" } }]),
	assistant("a3", [{ type: "text", text: "REPLY-TWO **bold**" }]),
];

function chat(overrides: Partial<CentralChat> & Pick<CentralChat, "id">): CentralChat {
	return {
		sessionId: `session-${overrides.id}`,
		pid: 1,
		name: "TMUX ORCHESTRATION",
		cwd: "/hq",
		busy: false,
		requests: [],
		...overrides,
	};
}

function commandMocks(): CentralFocusCommands & { [K in keyof CentralFocusCommands]: ReturnType<typeof vi.fn> } {
	return {
		relay: vi.fn(async (target: string, message: string) => `relayed to ${target}: ${message}`),
		inbox: vi.fn(async (count: number) => `INBOX-TAIL ${count}`),
		setPaused: vi.fn(async (paused: boolean) => (paused ? "PAUSED-STATE" : "RUNNING-STATE")),
		boardUrl: vi.fn(() => "https://board.example/board/"),
	} as never;
}

const flush = async () => {
	for (let index = 0; index < 12; index++) await Promise.resolve();
	// One macrotask hop lets mocked host promises settle; no wall-clock wait.
	await new Promise<void>(resolve => setImmediate(resolve));
};

async function setup(options: {
	snapshot: () => CentralSnapshot;
	transcript?: CentralTuiHost["transcript"];
	prompt?: CentralTuiHost["prompt"];
	answer?: CentralTuiHost["answer"];
	commands?: CentralFocusCommands;
	target?: string;
	width?: number;
	height?: number;
}) {
	const width = options.width ?? 110;
	const terminal = new VirtualTerminal(width, options.height ?? 40);
	const ui = new TUI(terminal, false, { renderScheduler: new VirtualRenderScheduler() });
	const refreshes: Array<() => void> = [];
	const originalSetTimeout = globalThis.setTimeout;
	// Polls run only when the test asks for one, so each phase is deterministic.
	globalThis.setTimeout = ((callback: () => void, ms?: number) => {
		if (ms === 1000) {
			refreshes.push(callback);
			return 0 as never;
		}
		return originalSetTimeout(callback, ms);
	}) as typeof setTimeout;
	const host: CentralTuiHost = {
		refresh: async () => options.snapshot(),
		transcript: options.transcript ?? (async () => mixedTranscript),
		answer: options.answer ?? (async () => {}),
		open: async () => {},
		workspace: async () => ({ statusLines: ["STATUS-ROW"], usageLines: ["USAGE-ROW"], canPrompt: true }),
		prompt: options.prompt ?? (async () => {}),
	};
	const commands = options.commands ?? commandMocks();
	const component = new CentralComponent(ui, host, undefined, {
		target: options.target ?? "TMUX ORCHESTRATION",
		prefix: PREFIX,
		commands,
	});
	component.focused = true;
	void component.run();
	await flush();
	component.render(width);
	await flush();
	const text = () =>
		component
			.render(width)
			.map(line => Bun.stripANSI(line))
			.join("\n");
	return {
		component,
		commands,
		text,
		input: async (value: string) => {
			component.handleInput(value);
			await flush();
			component.render(width);
			await flush();
		},
		poll: async () => {
			const next = refreshes.splice(0);
			for (const callback of next) callback();
			await flush();
			component.render(width);
			await flush();
		},
		close: () => {
			component.dispose();
			globalThis.setTimeout = originalSetTimeout;
		},
	};
}

describe("Central focus transcript", () => {
	it("keeps only assistant reply text and drops every other kind of entry and block", () => {
		const entries = focusTranscriptEntries(mixedTranscript);
		expect(entries.map(entry => entry.id)).toEqual(["a1", "a3"]);
		const first = entries[0]!;
		if (first.type !== "message" || first.message.role !== "assistant") throw new Error("Expected assistant");
		expect(first.message.content).toEqual([{ type: "text", text: "REPLY-ONE" }]);
		expect(first.message.stopReason).toBe("stop");
		expect(first.message.usage.totalTokens).toBe(0);
	});

	it("renders replies newest at the bottom with markdown and no tool, thinking, user or status chrome", async () => {
		const rig = await setup({ snapshot: () => ({ chats: [chat({ id: "local/hq" })], errors: [] }) });
		try {
			const text = rig.text();
			expect(text).toContain("REPLY-ONE");
			expect(text).toContain("REPLY-TWO bold");
			expect(text).not.toContain("**bold**");
			expect(text.indexOf("REPLY-ONE")).toBeLessThan(text.indexOf("REPLY-TWO"));
			for (const hidden of [
				"USER-SECRET",
				"THINK-SECRET",
				"TOOLCALL-SECRET",
				"RESULT-SECRET",
				"CUSTOM-SECRET",
				"ONLY-TOOL-SECRET",
				"STATUS-ROW",
				"USAGE-ROW",
			])
				expect(text).not.toContain(hidden);
		} finally {
			rig.close();
		}
	});
});

describe("Central focus composer", () => {
	it("sends the exact prefix and retries the identical payload under the same request ID", async () => {
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {
			if (prompt.mock.calls.length === 1) throw new Error("Disconnected");
		});
		const rig = await setup({ snapshot: () => ({ chats: [chat({ id: "local/hq" })], errors: [] }), prompt });
		try {
			await rig.input("hello HQ");
			await rig.input("\r");
			expect(prompt.mock.calls[0]).toEqual([
				"local/hq",
				"session-local/hq",
				expect.any(String),
				`${PREFIX}hello HQ`,
			]);
			expect(rig.text()).toContain("Delivery unconfirmed");
			expect(rig.text()).toContain("hello HQ");
			await rig.input("\x12");
			expect(prompt.mock.calls[1]).toEqual(prompt.mock.calls[0]);
			expect(rig.text()).not.toContain("hello HQ");
		} finally {
			rig.close();
		}
	});

	it("runs every slash command locally and never sends one to the focused chat", async () => {
		const prompt = vi.fn(async () => {});
		const commands = commandMocks();
		const snapshot: CentralSnapshot = {
			chats: [
				chat({
					id: "local/hq",
					busy: true,
					requests: [{ id: "q", createdAt: 1, kind: "editor", title: "Open question" }],
				}),
				chat({ id: "user@mini/m", name: "MINI CHAT", source: "user@mini", unresponsive: "host_timeout" }),
			],
			errors: ["other-host: SSH disconnected"],
		};
		const rig = await setup({ snapshot: () => snapshot, prompt, commands });
		try {
			// The question is focused first; F2 moves to the composer.
			await rig.input("\x1bOQ");
			await rig.input("/help");
			await rig.input("\r");
			expect(rig.text()).toContain("/send <chat> <msg>");
			expect(rig.text()).toContain("/inbox [N]");
			await rig.input("/chats");
			await rig.input("\r");
			expect(rig.text()).toContain("TMUX ORCHESTRATION · local · busy · 1 open question");
			expect(rig.text()).toContain("MINI CHAT · user@mini · not responding (host_timeout) · no question");
			expect(rig.text()).toContain("! other-host: SSH disconnected");
			await rig.input("/dag");
			await rig.input("\r");
			expect(rig.text()).toContain("https://board.example/board/");
			await rig.input("/inbox 3");
			await rig.input("\r");
			expect(commands.inbox).toHaveBeenCalledWith(3);
			expect(rig.text()).toContain("INBOX-TAIL 3");
			await rig.input("/inbox");
			await rig.input("\r");
			expect(commands.inbox).toHaveBeenLastCalledWith(10);
			await rig.input("/pause");
			await rig.input("\r");
			expect(rig.text()).toContain("PAUSED-STATE");
			await rig.input("/resume");
			await rig.input("\r");
			expect(commands.setPaused.mock.calls).toEqual([[true], [false]]);
			expect(rig.text()).toContain("RUNNING-STATE");
			await rig.input('/send "TMUX ORCHESTRATION" relay this');
			await rig.input("\r");
			expect(commands.relay).toHaveBeenCalledWith("TMUX ORCHESTRATION", "relay this");
			await rig.input("/send SPRILISTACK go");
			await rig.input("\r");
			expect(commands.relay).toHaveBeenLastCalledWith("SPRILISTACK", "go");
			await rig.input("/bogus thing");
			await rig.input("\r");
			expect(rig.text()).toContain("Unknown command /bogus; nothing was sent");
			expect(rig.text()).toContain("/bogus thing");
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});

	it("reports an unconfigured command without sending anything", async () => {
		const prompt = vi.fn(async () => {});
		const commands = commandMocks();
		commands.boardUrl = vi.fn(() => {
			throw new Error("Not configured: set central.focus.boardUrl");
		});
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq" })], errors: [] }),
			prompt,
			commands,
		});
		try {
			await rig.input("/dag");
			await rig.input("\r");
			expect(rig.text()).toContain("Not configured: set central.focus.boardUrl");
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});

	it("parses command arguments strictly", () => {
		expect(parseFocusCommand("plain text")).toBeUndefined();
		expect(parseFocusCommand("/inbox 0")).toMatchObject({ name: "error" });
		expect(parseFocusCommand("/inbox x")).toMatchObject({ name: "error" });
		expect(parseFocusCommand("/send onlychat")).toMatchObject({ name: "error" });
		expect(parseFocusCommand("/chats extra")).toMatchObject({ name: "error" });
		expect(parseFocusCommand("/send A multi\nline")).toEqual({ name: "send", chat: "A", message: "multi\nline" });
	});
});

describe("Central focus target", () => {
	it("follows the chat across a restart and a new session, keeping the view and draft while it is unavailable", async () => {
		let chats: CentralChat[] = [chat({ id: "local/a", sessionId: "s1" }), chat({ id: "local/x", name: "OTHER" })];
		let reply = "REPLY-A";
		let transcriptFails = false;
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {});
		const rig = await setup({
			snapshot: () => ({ chats, errors: [] }),
			transcript: async () => {
				if (transcriptFails) throw new Error("Chat is not responding (host_timeout)");
				return [assistant(reply, [{ type: "text", text: reply }])];
			},
			prompt,
		});
		try {
			expect(rig.text()).toContain("REPLY-A");
			await rig.input("keep me");

			chats = [{ ...chats[0]!, unresponsive: "host_timeout", transcriptRevision: "2" }, chats[1]!];
			transcriptFails = true;
			await rig.poll();
			expect(rig.text()).toContain("TMUX ORCHESTRATION: not responding (host_timeout); retrying");
			expect(rig.text()).toContain("REPLY-A");
			expect(rig.text()).toContain("keep me");

			chats = [chats[1]!];
			await rig.poll();
			expect(rig.text()).toContain("not responding; retrying (not listed by any host)");
			expect(rig.text()).toContain("REPLY-A");
			expect(rig.text()).toContain("keep me");
			await rig.input("\r");
			expect(prompt).not.toHaveBeenCalled();
			expect(rig.text()).toContain("not available; draft kept");

			// Restarted and resumed: a new process, the same session.
			transcriptFails = false;
			reply = "REPLY-B";
			chats = [chat({ id: "local/b", sessionId: "s1" }), chats[0]!];
			await rig.poll();
			expect(rig.text()).toContain("REPLY-B");
			expect(rig.text()).not.toContain("not responding");
			expect(rig.text()).toContain("keep me");
			await rig.poll();
			await rig.input("\r");
			expect(prompt.mock.calls[0]).toEqual(["local/b", "s1", expect.any(String), `${PREFIX}keep me`]);

			// A new session under the same name is followed by name.
			reply = "REPLY-C";
			chats = [chat({ id: "local/c", sessionId: "s2" }), chats[1]!];
			await rig.poll();
			expect(rig.text()).toContain("REPLY-C");
			await rig.poll();
			await rig.input("again");
			await rig.input("\r");
			expect(prompt.mock.calls[1]).toEqual(["local/c", "s2", expect.any(String), `${PREFIX}again`]);
		} finally {
			rig.close();
		}
	});

	it("refuses an ambiguous name and lists the matches", async () => {
		const prompt = vi.fn(async () => {});
		const rig = await setup({
			snapshot: () => ({
				chats: [chat({ id: "local/one", sessionId: "first" }), chat({ id: "user@mini/two", sessionId: "second" })],
				errors: [],
			}),
			prompt,
		});
		try {
			expect(rig.text()).toContain('"TMUX ORCHESTRATION" matches 2 chats');
			expect(rig.text()).toContain("session first");
			expect(rig.text()).toContain("session second");
			await rig.input("hello");
			await rig.input("\r");
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});

	it("resolves by sessionId, chatId suffix or name", () => {
		const chats = [chat({ id: "local/abc", sessionId: "sess-1" }), chat({ id: "user@mini/def", name: "MINI" })];
		expect(resolveFocusTarget(chats, "sess-1", {})).toMatchObject({ kind: "found", chat: { id: "local/abc" } });
		expect(resolveFocusTarget(chats, "def", {})).toMatchObject({ kind: "found", chat: { id: "user@mini/def" } });
		expect(resolveFocusTarget(chats, "mini", {})).toMatchObject({ kind: "found", chat: { id: "user@mini/def" } });
		expect(resolveFocusTarget(chats, "nobody", {})).toMatchObject({ kind: "missing" });
	});
});

describe("Central focus questions", () => {
	it("answers only the focused chat's question in place, and Esc returns to the composer without skipping", async () => {
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async () => {});
		const rig = await setup({
			snapshot: () => ({
				chats: [
					chat({ id: "local/hq", requests: [{ id: "q1", createdAt: 1, kind: "editor", title: "FOCUS TEST" }] }),
					chat({
						id: "local/other",
						name: "OTHER",
						requests: [{ id: "q2", createdAt: 0, kind: "editor", title: "OTHER QUESTION" }],
					}),
				],
				errors: [],
			}),
			answer,
			prompt,
		});
		try {
			expect(rig.text()).toContain("FOCUS TEST");
			expect(rig.text()).not.toContain("OTHER QUESTION");
			await rig.input("\x1b");
			await rig.input("composer text");
			expect(rig.text()).toContain("FOCUS TEST");
			await rig.input("\x1bOQ");
			await rig.input("Two");
			// Editor questions submit with Ctrl+Q, exactly as in Central.
			await rig.input("\x11");
			expect(answer.mock.calls).toEqual([["local/hq", "q1", "Two"]]);
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});
});
