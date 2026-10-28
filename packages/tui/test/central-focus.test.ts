import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { TranscriptEntryLike } from "../src/chat/transcript-entry";
import { TUI } from "../src/tui";
import { initTheme, theme } from "../src/theme/theme";
import { setClockTimeZone } from "../src/render/clock";
import { CentralComponent, type CentralExit, type CentralRestartOptions } from "../src/apps/central/central-tui";
import { focusTranscriptEntries, parseFocusCommand, resolveFocusTarget } from "../src/apps/central/focus";
import { selectCells, selectionText } from "../src/apps/central/selection";
import { DEFAULT_TAB_WIDTH } from "../src/utils";
import type {
	CentralChat,
	CentralFocusCommands,
	CentralRequest,
	CentralSnapshot,
	CentralTuiHost,
} from "../src/apps/central/types";
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

/** Another chat, on the Mini, with an open choice question older than any of the focused chat's. */
function otherAsk(overrides: Partial<CentralChat> = {}): CentralChat {
	return chat({
		id: "mini/other",
		name: "SPRILICIM",
		source: "mini",
		requests: [
			{
				id: "ask9",
				createdAt: 0,
				kind: "ask",
				questions: [{ id: "q", question: "OTHER ASK?", options: [{ label: "One" }, { label: "Two" }] }],
			},
		],
		...overrides,
	});
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
	command?: CentralTuiHost["command"];
	workspace?: Awaited<ReturnType<NonNullable<CentralTuiHost["workspace"]>>>;
	answer?: CentralTuiHost["answer"];
	commands?: CentralFocusCommands;
	target?: string;
	width?: number;
	height?: number;
	restart?: CentralRestartOptions;
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
		workspace: async () =>
			options.workspace ?? { statusLines: ["STATUS-ROW"], usageLines: ["USAGE-ROW"], canPrompt: true },
		prompt: options.prompt ?? (async () => {}),
		command: options.command,
	};
	const commands = options.commands ?? commandMocks();
	const copy = vi.fn((_text: string) => {});
	const component = new CentralComponent(ui, host, options.restart, {
		target: options.target ?? "TMUX ORCHESTRATION",
		prefix: PREFIX,
		copyToClipboard: copy,
		commands,
	});
	component.focused = true;
	let exit: CentralExit | undefined;
	void component.run().then(value => {
		exit = value;
	});
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
		copy,
		text,
		/** How the view ended (`restart`: it restarted itself onto a new build), or undefined while running. */
		exit: () => exit,
		/** Rendered frame rows with styling, for checking the selection highlight. */
		raw: () => component.render(width).join("\n"),
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

	it("groups each reply into one turn under an Eastern time divider and shows only focus messages as 'you:'", async () => {
		const at = Date.UTC(2026, 9, 23, 2, 38);
		const user = (id: string, text: string): TranscriptEntryLike => ({
			type: "message",
			id,
			parentId: null,
			timestamp: new Date(at).toISOString(),
			message: { role: "user", content: text, timestamp: at },
		});
		const reply = (id: string, text: string, minute: number): TranscriptEntryLike => {
			const entry = assistant(id, [{ type: "text", text }]);
			(entry as { message: { timestamp: number } }).message.timestamp = at + minute * 60_000;
			return entry;
		};
		const transcript = [
			user("u1", `${PREFIX}SENT-FROM-FOCUS`),
			// One reply split by a hidden tool call: one turn, timed by its first part.
			reply("a1", "FIRST-PART", 0),
			assistant("tool", [{ type: "toolCall", id: "c", name: "bash", arguments: {} }]),
			reply("a2", "SECOND-PART", 1),
			user("u2", "PLAIN-USER-SECRET"),
			reply("a3", "NEXT-REPLY", 5),
		];
		setClockTimeZone("America/New_York");
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", busy: true })], errors: [] }),
			transcript: async () => transcript,
		});
		try {
			const text = rig.text();
			expect(text).toContain("you: SENT-FROM-FOCUS");
			expect(text).not.toContain(PREFIX.trim());
			expect(text).not.toContain("PLAIN-USER-SECRET");
			// 02:38 UTC is 10:38 PM Eastern (EDT).
			const dividers = text.split("\n").filter(line => /─ \d{1,2}:\d{2} [AP]M ─/.test(line));
			expect(dividers.map(line => /\d{1,2}:\d{2} [AP]M/.exec(line)![0])).toEqual(["10:38 PM", "10:43 PM"]);
			const order = ["you: SENT-FROM-FOCUS", "FIRST-PART", "SECOND-PART", "NEXT-REPLY"].map(s => text.indexOf(s));
			expect(order).toEqual([...order].sort((a, b) => a - b));
			expect(text).toContain("…working");
		} finally {
			rig.close();
			setClockTimeZone(undefined);
		}
	});

	it("shows a message sent from the composer at once, marked queued, until the chat's transcript has it", async () => {
		let transcript: TranscriptEntryLike[] = [assistant("a1", [{ type: "text", text: "EARLIER-REPLY" }])];
		let revision = "1";
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", busy: true, transcriptRevision: revision })], errors: [] }),
			transcript: async () => transcript,
		});
		try {
			await rig.input("status please");
			await rig.input("\r");
			expect(rig.text()).toContain("you: status please  (queued)");
			transcript = [
				...transcript,
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: `${PREFIX}status please`, timestamp: Date.now() },
				},
			];
			revision = "2";
			await rig.poll();
			await rig.poll();
			expect(rig.text()).toContain("you: status please");
			expect(rig.text()).not.toContain("(queued)");
			expect(rig.text().split("you: status please")).toHaveLength(2);
		} finally {
			rig.close();
		}
	});

	/** A focus "ok" the chat stamped at `at`; Central's ids are positions in its capped tail. */
	const sentOk = (id: string, at: number): TranscriptEntryLike => ({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: `${PREFIX}ok`, timestamp: at },
	});
	const minuteAgo = () => Date.now() - 60_000;

	it("keeps a repeated short message queued until a copy stamped at or after its send arrives", async () => {
		let transcript: TranscriptEntryLike[] = [
			sentOk("central-0", minuteAgo()),
			assistant("central-1", [{ type: "text", text: "REPLY" }]),
		];
		let revision = "1";
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", busy: true, transcriptRevision: revision })], errors: [] }),
			transcript: async () => transcript,
		});
		try {
			await rig.input("ok");
			await rig.input("\r");
			expect(rig.text()).toContain("you: ok  (queued)");
			// A reload that still holds only the earlier "ok" must not clear the new one.
			transcript = [...transcript, assistant("central-2", [{ type: "text", text: "MORE" }])];
			revision = "2";
			await rig.poll();
			await rig.poll();
			expect(rig.text()).toContain("you: ok  (queued)");
			transcript = [...transcript, sentOk("central-3", Date.now())];
			revision = "3";
			await rig.poll();
			await rig.poll();
			expect(rig.text()).not.toContain("(queued)");
			expect(rig.text().split("you: ok")).toHaveLength(3);
		} finally {
			rig.close();
		}
	});

	it("matches each sent copy once when an old identical one drops off the front of the capped tail", async () => {
		const reply = assistant("central-1", [{ type: "text", text: "REPLY" }]);
		let transcript: TranscriptEntryLike[] = [sentOk("central-0", minuteAgo()), reply];
		let revision = "1";
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", busy: true, transcriptRevision: revision })], errors: [] }),
			transcript: async () => transcript,
		});
		try {
			await rig.input("ok");
			await rig.input("\r");
			await rig.input("ok");
			await rig.input("\r");
			expect(rig.text().split("(queued)")).toHaveLength(3);
			// The old "ok" falls off the front as the first new copy lands.
			const first = Date.now();
			transcript = [{ ...reply, id: "central-0" }, sentOk("central-1", first)];
			revision = "2";
			await rig.poll();
			await rig.poll();
			expect(rig.text().split("(queued)")).toHaveLength(2);
			// The copy the first send claimed never clears the second one, even as ids shift.
			transcript = [sentOk("central-0", first), assistant("central-1", [{ type: "text", text: "MORE" }])];
			revision = "3";
			await rig.poll();
			await rig.poll();
			expect(rig.text().split("(queued)")).toHaveLength(2);
			transcript = [...transcript, sentOk("central-2", first + 1)];
			revision = "4";
			await rig.poll();
			await rig.poll();
			expect(rig.text()).not.toContain("(queued)");
			expect(rig.text().split("you: ok")).toHaveLength(3);
		} finally {
			rig.close();
		}
	});

	it("never takes an old copy whose position index shifted for the new send's copy", async () => {
		let transcript: TranscriptEntryLike[] = [
			assistant("central-0", [{ type: "text", text: "FIRST" }]),
			sentOk("central-1", minuteAgo()),
		];
		let revision = "1";
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", busy: true, transcriptRevision: revision })], errors: [] }),
			transcript: async () => transcript,
		});
		try {
			await rig.input("ok");
			await rig.input("\r");
			// The front entry drops off: the old "ok" now sits at the index "central-0".
			transcript = [transcript[1]!, assistant("central-1", [{ type: "text", text: "LATER" }])].map(
				(entry, index) => ({
					...entry,
					id: `central-${index}`,
				}),
			);
			revision = "2";
			await rig.poll();
			await rig.poll();
			expect(rig.text()).toContain("you: ok  (queued)");
			transcript = [...transcript, sentOk("central-2", Date.now())];
			revision = "3";
			await rig.poll();
			await rig.poll();
			expect(rig.text()).not.toContain("(queued)");
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
			// Delivered: the composer is empty; the message now shows only as a queued 'you:' line.
			expect(rig.text()).not.toContain("╰─ hello HQ");
			expect(rig.text()).toContain("you: hello HQ  (queued)");
		} finally {
			rig.close();
		}
	});

	it("runs the local commands locally and refuses chat commands when the chat cannot run them", async () => {
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
		const command = vi.fn(async () => "must not run");
		const rig = await setup({ snapshot: () => snapshot, prompt, command, commands });
		try {
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
			// An older chat host advertises no canCommand: nothing is sent, as prompt or command.
			await rig.input("/bogus thing");
			await rig.input("\r");
			expect(rig.text()).toContain("update OMP on the chat's host. Nothing was sent.");
			expect(rig.text()).toContain("/bogus thing");
			expect(prompt).not.toHaveBeenCalled();
			expect(command).not.toHaveBeenCalled();
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

	it("parses command arguments strictly; any other /name is for the focused chat", () => {
		expect(parseFocusCommand("plain text")).toBeUndefined();
		expect(parseFocusCommand("/inbox 0")).toMatchObject({ name: "error" });
		expect(parseFocusCommand("/inbox x")).toMatchObject({ name: "error" });
		expect(parseFocusCommand("/send onlychat")).toMatchObject({ name: "error" });
		expect(parseFocusCommand("/chats extra")).toMatchObject({ name: "error" });
		expect(parseFocusCommand("/send A multi\nline")).toEqual({ name: "send", chat: "A", message: "multi\nline" });
		expect(parseFocusCommand("  /state verbose ")).toEqual({ name: "remote", text: "/state verbose" });
		expect(parseFocusCommand("/")).toMatchObject({ name: "error" });
	});

	const commandWorkspace = {
		statusLines: ["STATUS-ROW"],
		usageLines: ["USAGE-ROW"],
		canPrompt: true,
		canCommand: true,
		commands: [
			{ name: "refresh", description: "Restart OMP" },
			{ name: "compact", description: "Compact context" },
		],
	};

	it("runs any other /command in the focused chat with the command op, never as a prefixed prompt", async () => {
		const prompt = vi.fn(async () => {});
		const command = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["command"]>>) => "Restarting…");
		const commands = commandMocks();
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq" })], errors: [] }),
			prompt,
			command,
			commands,
			workspace: commandWorkspace,
		});
		try {
			await rig.input("/refresh");
			await rig.input("\r");
			expect(command.mock.calls).toEqual([["local/hq", "session-local/hq", expect.any(String), "/refresh"]]);
			expect(prompt).not.toHaveBeenCalled();
			expect(rig.text()).toMatch(/── \d{1,2}:\d{2} [AP]M · \/refresh · ran in the chat ──/);
			expect(rig.text()).toContain("Restarting…");
			expect(rig.text()).not.toContain("(queued)");
			await rig.input("/inbox 5");
			await rig.input("\r");
			expect(commands.inbox).toHaveBeenCalledWith(5);
			expect(command).toHaveBeenCalledTimes(1);
			await rig.input("/help");
			await rig.input("\r");
			expect(rig.text()).toContain("/send <chat> <msg>");
			expect(rig.text()).toContain("/refresh  /compact");
			expect(command).toHaveBeenCalledTimes(1);
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});

	it("retries an unconfirmed command with the same request ID and the command op", async () => {
		const prompt = vi.fn(async () => {});
		const command = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["command"]>>) => {
			if (command.mock.calls.length === 1) throw new Error("Disconnected");
			return "ran";
		});
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq" })], errors: [] }),
			prompt,
			command,
			workspace: commandWorkspace,
		});
		try {
			await rig.input("/compact");
			await rig.input("\r");
			expect(rig.text()).toContain("Result unknown");
			await rig.input("\x12");
			expect(command.mock.calls[1]).toEqual(command.mock.calls[0]);
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});

	it("pops up local and chat commands on '/' and Enter completes the selection without sending", async () => {
		const prompt = vi.fn(async () => {});
		const command = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["command"]>>) => "ran");
		const rig = await setup({
			snapshot: () => ({
				chats: [
					chat({
						id: "local/hq",
						requests: [{ id: "q", createdAt: 1, kind: "select", title: "Pick", options: ["A", "B"] }],
					}),
				],
				errors: [],
			}),
			prompt,
			command,
			workspace: commandWorkspace,
		});
		try {
			await rig.input("/");
			const shown = rig.text();
			for (const name of ["refresh", "compact", "chats", "inbox", "help"]) expect(shown).toContain(name);
			expect(shown).toContain("local · task board URL");
			await rig.input("ref");
			// The editor narrows the list after its 100 ms debounce, as in the main chat.
			await Bun.sleep(150);
			await rig.input("");
			expect(rig.text()).not.toContain("local · task board URL");
			expect(rig.text()).toContain("Restart OMP");
			// Down moves the popup selection; it never hands focus to the open question.
			await rig.input("\x1b[B");
			await rig.input("\x1b[A");
			expect(rig.text()).toContain("── new question · TMUX ORCHESTRATION · F2 to answer ──");
			await rig.input("\r");
			expect(command).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(rig.text()).toMatch(/\/refresh\s/);
			await rig.input("\r");
			expect(command.mock.calls[0]?.[3]).toBe("/refresh");
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
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
	it("never lets a question capture composer typing, and answers only the focused chat's question after F2", async () => {
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {});
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
			// Composer has focus: text and Enter typed while a question is open never answer it.
			await rig.input("composer text");
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
			expect(prompt.mock.calls).toEqual([
				["local/hq", "session-local/hq", expect.any(String), `${PREFIX}composer text`],
			]);
			expect(rig.text()).toContain("FOCUS TEST");
			await rig.input("\x1bOQ");
			await rig.input("Two");
			// Editor questions submit with Ctrl+Q, exactly as in Central.
			await rig.input("\x11");
			expect(answer.mock.calls).toEqual([["local/hq", "q1", "Two"]]);
			// After the answer, typing goes back to the composer.
			await rig.input("after");
			expect(answer).toHaveBeenCalledTimes(1);
			expect(rig.text()).toContain("after");
		} finally {
			rig.close();
		}
	});

	const askChat = () =>
		chat({
			id: "local/hq",
			requests: [
				{
					id: "ask1",
					createdAt: 1,
					kind: "ask",
					questions: [{ id: "eval", question: "WHICH EVAL?", options: [{ label: "One" }, { label: "Two" }] }],
				},
			],
		});

	it("answers an open choice question with arrows and Enter while the composer is empty, no F2", async () => {
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async () => {});
		const rig = await setup({ snapshot: () => ({ chats: [askChat()], errors: [] }), answer, prompt });
		try {
			expect(rig.text()).toContain("WHICH EVAL?");
			await rig.input("\x1b[B");
			await rig.input("\r");
			expect(prompt).not.toHaveBeenCalled();
			expect(answer.mock.calls).toHaveLength(1);
			expect(answer.mock.calls[0]!.slice(0, 2)).toEqual(["local/hq", "ask1"]);
			expect(answer.mock.calls[0]![2]).toMatchObject({
				kind: "submit",
				results: [expect.objectContaining({ selectedOptions: ["Two"] })],
			});
		} finally {
			rig.close();
		}
	});

	it("never answers or cancels a question from an empty composer with Esc, Space, a digit, or Enter as it appears", async () => {
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async () => {});
		const clock = { now: 1_000_000 };
		const rig = await setup({
			snapshot: () => ({ chats: [askChat()], errors: [] }),
			answer,
			prompt,
			restart: { restartReady: () => false, now: () => clock.now },
		});
		try {
			for (const key of ["\r", "\x1b", " ", "2", "1"]) {
				await rig.input(key);
				// Typed characters land in the composer; clear them before the next key.
				for (let index = 0; index < 3; index++) await rig.input("\x7f");
			}
			expect(answer).not.toHaveBeenCalled();
			expect(rig.text()).toContain("WHICH EVAL?");
			// Typing "2 evals" goes to the composer, never picks option 2.
			await rig.input("2 evals");
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
			expect(prompt.mock.calls.map(call => (call as unknown[])[3])).toEqual([`${PREFIX}2 evals`]);
			// Esc after moving into the question returns to the composer; it does not
			// cancel, and the question is no longer new, so Enter there stays the composer's.
			await rig.input("\x1b[B");
			await rig.input("\x1b");
			clock.now += 5000;
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});

	it("keeps Enter for the composer once it holds a draft, even with a question open", async () => {
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {});
		const rig = await setup({ snapshot: () => ({ chats: [askChat()], errors: [] }), answer, prompt });
		try {
			await rig.input("hello");
			await rig.input("\x1b[B");
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
			expect(prompt.mock.calls.map(call => call[3])).toEqual([`${PREFIX}hello`]);
		} finally {
			rig.close();
		}
	});

	it("shows slash-command output on screen while a question card is open, even with a long history", async () => {
		const prompt = vi.fn(async () => {});
		const longHistory = Array.from({ length: 60 }, (_, index) =>
			assistant(`r${index}`, [{ type: "text", text: `HISTORY LINE ${index}` }]),
		);
		const rig = await setup({
			snapshot: () => ({ chats: [askChat()], errors: [] }),
			transcript: async () => longHistory,
			prompt,
			height: 30,
		});
		try {
			await rig.input("/inbox 3");
			await rig.input("\r");
			expect(rig.text()).toContain("INBOX-TAIL 3");
			expect(rig.text()).toContain("WHICH EVAL?");
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});

	it("shows another host's open question headed by its chat and host, and answers it only in that chat", async () => {
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async () => {});
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq" }), otherAsk()], errors: [] }),
			answer,
			prompt,
		});
		try {
			const text = rig.text();
			expect(text).toContain("── new question · SPRILICIM (mini) · Enter or ↓ to answer ──");
			expect(text).toContain("OTHER ASK?");
			expect(text).toContain("0 open questions  ·  1 from other chats");
			await rig.input("\x1b[B");
			expect(rig.text()).toContain("── question · SPRILICIM (mini) · focused ──");
			await rig.input("\r");
			expect(prompt).not.toHaveBeenCalled();
			expect(answer.mock.calls).toHaveLength(1);
			expect(answer.mock.calls[0]!.slice(0, 2)).toEqual(["mini/other", "ask9"]);
			expect(answer.mock.calls[0]![2]).toMatchObject({
				kind: "submit",
				results: [expect.objectContaining({ selectedOptions: ["Two"] })],
			});
			expect(rig.text()).not.toContain("OTHER ASK?");
		} finally {
			rig.close();
		}
	});

	it("puts the focused chat's question first and cycles every chat's questions with Tab from the card", async () => {
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async () => {});
		const own = chat({
			id: "local/hq",
			requests: [
				{
					id: "own1",
					createdAt: 5,
					kind: "ask",
					questions: [{ id: "q", question: "OWN ASK?", options: [{ label: "One" }, { label: "Two" }] }],
				},
			],
		});
		// The other chat's question is older, yet the focused chat's comes first.
		const rig = await setup({ snapshot: () => ({ chats: [otherAsk(), own], errors: [] }), answer, prompt });
		try {
			let text = rig.text();
			expect(text).toContain(
				"── new question 1 of 2 · TMUX ORCHESTRATION · Enter or ↓ to answer · new question from SPRILICIM (mini) ──",
			);
			expect(text).toContain("OWN ASK?");
			expect(text).not.toContain("OTHER ASK?");
			// Enter on the empty composer as the card appears answers nothing; Tab there stays the composer's.
			await rig.input("\r");
			await rig.input("\t");
			await rig.input("\x1b");
			expect(answer).not.toHaveBeenCalled();
			expect(rig.text()).toContain(
				"── new question 1 of 2 · TMUX ORCHESTRATION · Enter or ↓ to answer · new question from SPRILICIM (mini) ──",
			);
			await rig.input("\x1bOQ");
			expect(rig.text()).toContain(
				"── question 1 of 2 · TMUX ORCHESTRATION · focused · new question from SPRILICIM (mini) ──",
			);
			expect(rig.text()).toContain("Tab/Shift+Tab next question");
			await rig.input("\t");
			text = rig.text();
			expect(text).toContain("── question 2 of 2 · SPRILICIM (mini) · focused ──");
			expect(text).toContain("OTHER ASK?");
			// A poll never swaps the card the keyboard is in.
			await rig.poll();
			expect(rig.text()).toContain("── question 2 of 2 · SPRILICIM (mini) · focused ──");
			await rig.input("\x1b[Z");
			expect(rig.text()).toContain("OWN ASK?");
			await rig.input("\t");
			await rig.input("\r");
			expect(prompt).not.toHaveBeenCalled();
			expect(answer.mock.calls).toHaveLength(1);
			expect(answer.mock.calls[0]!.slice(0, 2)).toEqual(["mini/other", "ask9"]);
			expect(answer.mock.calls[0]![2]).toMatchObject({
				results: [expect.objectContaining({ selectedOptions: ["One"] })],
			});
			// Answered: its card is gone, and the keyboard is back in the composer.
			text = rig.text();
			expect(text).toContain("── question · TMUX ORCHESTRATION ──");
			expect(text).not.toContain("OTHER ASK?");
		} finally {
			rig.close();
		}
	});

	it("marks a not-responding chat's last-known question and answers it only once the chat responds", async () => {
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async () => {});
		let unresponsive: string | undefined = "host_timeout";
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq" }), otherAsk({ unresponsive })], errors: [] }),
			answer,
			prompt,
		});
		try {
			const text = rig.text();
			expect(text).toContain("── new question · SPRILICIM (mini) · not responding ──");
			expect(text).toContain("SPRILICIM (mini) is not responding (host_timeout)");
			expect(text).toContain("OTHER ASK?");
			// Arrows on the empty composer do not move into it; F2 does, but no key answers it.
			await rig.input("\x1b[B");
			await rig.input("\r");
			await rig.input("\x1bOQ");
			await rig.input("\x1b[B");
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			unresponsive = undefined;
			await rig.poll();
			expect(rig.text()).not.toContain("not responding");
			await rig.input("\r");
			expect(answer.mock.calls.map(call => call.slice(0, 2))).toEqual([["mini/other", "ask9"]]);
		} finally {
			rig.close();
		}
	});
});

describe("Central focus auto-focus", () => {
	/** The footer hint while the keyboard is in a question card. */
	const IN_CARD = "Enter answer · Esc back to input";
	const choice = (id: string, question: string, createdAt = 1): CentralRequest => ({
		id,
		createdAt,
		kind: "ask",
		questions: [{ id: "q", question, options: [{ label: "One" }, { label: "Two" }] }],
	});
	/** Each answer as [chat, request, picked options]. */
	const answers = (calls: ReadonlyArray<Parameters<CentralTuiHost["answer"]>>) =>
		calls.map(([chatId, requestId, value]) => [
			chatId,
			requestId,
			typeof value === "object" && "results" in value ? value.results[0]?.selectedOptions : value,
		]);
	const longHistory = Array.from({ length: 60 }, (_, index) =>
		assistant(`r${index}`, [{ type: "text", text: `HISTORY LINE ${index}` }]),
	);
	/** A clock the test moves; `restart.now` drives the 3 s quiet threshold (the restart itself never fires). */
	const quietClock = () => {
		const clock = { now: 1_000_000 };
		return { clock, restart: { restartReady: () => false, now: () => clock.now } };
	};

	const cases: Array<{
		name: string;
		chats: (arrived: boolean) => CentralChat[];
		before?: (input: (value: string) => Promise<void>) => Promise<void>;
		transcript?: CentralTuiHost["transcript"];
		height?: number;
		expected: [string, string];
	}> = [
		{
			name: "the focused chat's own question",
			chats: arrived => [chat({ id: "local/hq", requests: arrived ? [choice("n", "NEW ASK?")] : [] })],
			expected: ["local/hq", "n"],
		},
		{
			name: "another host's question",
			chats: arrived => [chat({ id: "local/hq" }), otherAsk({ requests: arrived ? [choice("n", "NEW ASK?")] : [] })],
			expected: ["mini/other", "n"],
		},
		{
			name: "a question while the transcript is scrolled up",
			chats: arrived => [chat({ id: "local/hq" }), otherAsk({ requests: arrived ? [choice("n", "NEW ASK?")] : [] })],
			transcript: async () => longHistory,
			before: async input => {
				for (let index = 0; index < 6; index++) await input("\x1b[1;2A");
			},
			expected: ["mini/other", "n"],
		},
		{
			name: "a question while another chat's untouched card is shown",
			chats: arrived => [
				chat({ id: "local/hq", requests: [choice("o", "OLD ASK?", 5)] }),
				otherAsk({ requests: arrived ? [choice("n", "NEW ASK?", 9)] : [] }),
			],
			// The keyboard went into the old card and back without answering.
			before: async input => {
				await input("\x1bOQ");
				await input("\x1b");
			},
			expected: ["mini/other", "n"],
		},
		{
			name: "a question asked again after the target restarted under a new id",
			chats: arrived =>
				arrived
					? [chat({ id: "local/hq-restarted", sessionId: "s2", requests: [choice("n", "NEW ASK?")] })]
					: [chat({ id: "local/hq" })],
			expected: ["local/hq-restarted", "n"],
		},
		{
			name: "a question after a click on the transcript",
			chats: arrived => [chat({ id: "local/hq", requests: arrived ? [choice("n", "NEW ASK?")] : [] })],
			before: async input => {
				await input("\x1b[<0;5;5M");
				await input("\x1b[<0;5;5m");
			},
			expected: ["local/hq", "n"],
		},
		{
			name: "a question in a short terminal (compact card)",
			chats: arrived => [chat({ id: "local/hq", requests: arrived ? [choice("n", "NEW ASK?")] : [] })],
			height: 16,
			expected: ["local/hq", "n"],
		},
	];
	for (const testCase of cases) {
		it(`takes the keyboard after 3 s quiet with the composer empty: ${testCase.name}`, async () => {
			let arrived = false;
			const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
			const prompt = vi.fn(async () => {});
			const { clock, restart } = quietClock();
			const rig = await setup({
				snapshot: () => ({ chats: testCase.chats(arrived), errors: [] }),
				transcript: testCase.transcript,
				height: testCase.height,
				answer,
				prompt,
				restart,
			});
			try {
				await testCase.before?.(rig.input);
				arrived = true;
				await rig.poll();
				expect(rig.text()).toContain("NEW ASK?");
				// Input was not quiet for 3 s yet.
				expect(rig.text()).not.toContain(IN_CARD);
				clock.now += 3000;
				await rig.poll();
				expect(rig.text()).toContain("NEW ASK?");
				expect(rig.text()).toContain(IN_CARD);
				await rig.input("\x1b[B");
				await rig.input("\r");
				expect(prompt).not.toHaveBeenCalled();
				expect(answers(answer.mock.calls)).toEqual([[...testCase.expected, ["Two"]]]);
			} finally {
				rig.close();
			}
		});
	}

	it("takes the keyboard from the F8 view of a kept draft, closing it", async () => {
		let requests = [choice("old", "OLD ASK?")];
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const { clock, restart } = quietClock();
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", requests })], errors: [] }),
			answer,
			restart,
		});
		try {
			await rig.input("\x1b[B");
			requests = [];
			await rig.poll();
			await rig.input("\x1b[19~");
			requests = [choice("n", "NEW ASK?")];
			await rig.poll();
			expect(rig.text()).toContain("new question waiting · F8/Esc back · F9 discard · ");
			// The header is highlighted (bold warning), not dim.
			const marked = theme.bold(theme.fg("warning", "\0")).split("\0")[0]!;
			expect(rig.raw()).toContain(`${marked}── kept draft · TMUX ORCHESTRATION`);
			clock.now += 3000;
			await rig.poll();
			const text = rig.text();
			expect(text).not.toContain("kept draft ·");
			expect(text).toContain("── question · TMUX ORCHESTRATION · focused ──");
			await rig.input("\x1b[B");
			await rig.input("\r");
			expect(answers(answer.mock.calls)).toEqual([["local/hq", "n", ["Two"]]]);
		} finally {
			rig.close();
		}
	});

	it("gives two questions arriving together the keyboard one after the other, the focused chat's first", async () => {
		let own: CentralRequest[] = [];
		let other: CentralRequest[] = [];
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const { clock, restart } = quietClock();
		const rig = await setup({
			snapshot: () => ({
				chats: [chat({ id: "local/hq", requests: own }), otherAsk({ requests: other })],
				errors: [],
			}),
			answer,
			restart,
		});
		try {
			own = [choice("n", "NEW ASK?", 3)];
			other = [choice("n2", "SECOND ASK?", 2)];
			await rig.poll();
			clock.now += 3000;
			await rig.poll();
			expect(rig.text()).toContain(
				"── question 1 of 2 · TMUX ORCHESTRATION · focused · new question from SPRILICIM (mini) ──",
			);
			await rig.input("\x1b[B");
			await rig.input("\r");
			own = [];
			await rig.poll();
			// The answer was a key: the second waits, marked, until input is quiet again.
			expect(rig.text()).toContain("── new question · SPRILICIM (mini) · Enter or ↓ to answer ──");
			expect(rig.text()).not.toContain(IN_CARD);
			clock.now += 3000;
			await rig.poll();
			expect(rig.text()).toContain("── question · SPRILICIM (mini) · focused ──");
			// Enter alone right after a switch is the composer's; a second later it answers.
			clock.now += 1000;
			await rig.input("\r");
			expect(answers(answer.mock.calls)).toEqual([
				["local/hq", "n", ["Two"]],
				["mini/other", "n2", ["One"]],
			]);
		} finally {
			rig.close();
		}
	});

	it("marks a question that arrives while the composer has text or a popup, and it takes the keyboard once the composer is empty and quiet", async () => {
		let requests: CentralRequest[] = [];
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async () => {});
		const { clock, restart } = quietClock();
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", requests })], errors: [] }),
			answer,
			prompt,
			restart,
		});
		try {
			await rig.input("hello");
			requests = [choice("n", "NEW ASK?")];
			await rig.poll();
			clock.now += 10_000;
			await rig.poll();
			let text = rig.text();
			expect(text).toContain("── new question · TMUX ORCHESTRATION · F2 to answer ──");
			expect(text).toContain("new question: F2 to answer · ");
			expect(text).not.toContain(IN_CARD);
			const marked = theme.bold(theme.fg("warning", "\0")).split("\0")[0]!;
			expect(rig.raw()).toContain(`${marked}── new question · TMUX ORCHESTRATION · F2 to answer ──`);
			// The slash popup is the composer's too.
			for (let index = 0; index < 5; index++) await rig.input("\x7f");
			await rig.input("/");
			expect(rig.text()).toContain("local · task board URL");
			clock.now += 10_000;
			await rig.poll();
			expect(rig.text()).not.toContain(IN_CARD);
			await rig.input("\x7f");
			clock.now += 2999;
			await rig.poll();
			text = rig.text();
			expect(text).toContain("── new question · TMUX ORCHESTRATION · Enter or ↓ to answer ──");
			expect(text).not.toContain(IN_CARD);
			clock.now += 1;
			await rig.poll();
			expect(rig.text()).toContain("── question · TMUX ORCHESTRATION · focused ──");
			clock.now += 1000;
			await rig.input("\r");
			expect(prompt).not.toHaveBeenCalled();
			expect(answers(answer.mock.calls)).toEqual([["local/hq", "n", ["One"]]]);
		} finally {
			rig.close();
		}
	});

	it("never lets a key typed as it takes the keyboard land in the card", async () => {
		const requests: CentralRequest[] = [choice("n", "NEW ASK?")];
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async (..._args: Parameters<NonNullable<CentralTuiHost["prompt"]>>) => {});
		const { clock, restart } = quietClock();
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", requests })], errors: [] }),
			answer,
			prompt,
			restart,
		});
		try {
			// Quiet is measured from the last key at the moment of the switch.
			clock.now += 2000;
			await rig.input("\x7f");
			clock.now += 2999;
			await rig.poll();
			expect(rig.text()).not.toContain(IN_CARD);
			clock.now += 1;
			await rig.poll();
			expect(rig.text()).toContain(IN_CARD);
			// Typing that began as it switched goes to the composer, with the keyboard.
			await rig.input("h");
			let text = rig.text();
			expect(text).not.toContain(IN_CARD);
			expect(text).toContain("── new question · TMUX ORCHESTRATION · F2 to answer ──");
			await rig.input("i");
			await rig.input("\r");
			expect(prompt.mock.calls.map(call => call[3])).toEqual([`${PREFIX}hi`]);
			// A paste and Enter right after a switch are the composer's as well.
			clock.now += 3000;
			await rig.poll();
			expect(rig.text()).toContain(IN_CARD);
			await rig.input("\x1b[200~2\x1b[201~");
			expect(rig.text()).not.toContain(IN_CARD);
			await rig.input("\x7f");
			clock.now += 3000;
			await rig.poll();
			expect(rig.text()).toContain(IN_CARD);
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
			text = rig.text();
			expect(text).not.toContain(IN_CARD);
			expect(text).toContain("── new question · TMUX ORCHESTRATION · Enter or ↓ to answer ──");
			// After the window, keys are the card's.
			clock.now += 3000;
			await rig.poll();
			clock.now += 1000;
			await rig.input("\x1b[B");
			await rig.input("\r");
			expect(answers(answer.mock.calls)).toEqual([["local/hq", "n", ["Two"]]]);
			expect(prompt).toHaveBeenCalledTimes(1);
		} finally {
			rig.close();
		}
	});

	it("answers a new question's highlighted choice with Enter on the empty composer once it has shown 1 s and no key came 1 s before", async () => {
		let requests: CentralRequest[] = [];
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const prompt = vi.fn(async () => {});
		const { clock, restart } = quietClock();
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", requests })], errors: [] }),
			answer,
			prompt,
			restart,
		});
		try {
			// The question arrives 1.5 s after the last key: too soon to take the keyboard by itself.
			clock.now += 1500;
			requests = [choice("n", "NEW ASK?")];
			await rig.poll();
			expect(rig.text()).toContain("── new question · TMUX ORCHESTRATION · Enter or ↓ to answer ──");
			expect(rig.text()).not.toContain(IN_CARD);
			// Enter as the card appears is not an answer, however quiet the keys were.
			clock.now += 500;
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
			// Nor is Enter right after another key (a message just sent, a double press).
			clock.now += 999;
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
			// Shown long enough and quiet: Enter answers with the highlighted choice.
			clock.now += 1000;
			await rig.input("\r");
			expect(prompt).not.toHaveBeenCalled();
			expect(answers(answer.mock.calls)).toEqual([["local/hq", "n", ["One"]]]);
		} finally {
			rig.close();
		}
	});

	it("keeps Enter for the composer on a new free-text question", async () => {
		let requests: CentralRequest[] = [];
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const { clock, restart } = quietClock();
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", requests })], errors: [] }),
			answer,
			restart,
		});
		try {
			requests = [{ id: "e", createdAt: 1, kind: "editor", title: "WHY THIS ONE?" }];
			await rig.poll();
			expect(rig.text()).toContain("── new question · TMUX ORCHESTRATION · ↓ or F2 to answer ──");
			clock.now += 2000;
			await rig.input("\r");
			expect(answer).not.toHaveBeenCalled();
			expect(rig.text()).not.toContain(IN_CARD);
		} finally {
			rig.close();
		}
	});

	it("never replaces a card the keyboard is in or an answer was started on", async () => {
		let own: CentralRequest[] = [];
		let other: CentralRequest[] = [];
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const { clock, restart } = quietClock();
		const rig = await setup({
			snapshot: () => ({
				chats: [chat({ id: "local/hq", requests: own }), otherAsk({ requests: other })],
				errors: [],
			}),
			answer,
			restart,
		});
		try {
			own = [choice("a", "OWN ASK?")];
			await rig.poll();
			clock.now += 3000;
			await rig.poll();
			expect(rig.text()).toContain("── question · TMUX ORCHESTRATION · focused ──");
			// Keyboard in the untouched card: the new one waits, named in the header.
			other = [choice("b", "OTHER NEW ASK?", 9)];
			await rig.poll();
			clock.now += 10_000;
			await rig.poll();
			expect(rig.text()).toContain(
				"── question 1 of 2 · TMUX ORCHESTRATION · focused · new question from SPRILICIM (mini) ──",
			);
			// An answer started, then back to the composer: still not replaced.
			await rig.input("\x1b[B");
			await rig.input("\x1b");
			clock.now += 10_000;
			await rig.poll();
			let text = rig.text();
			expect(text).toContain("OWN ASK?");
			expect(text).not.toContain("OTHER NEW ASK?");
			expect(text).not.toContain(IN_CARD);
			await rig.input("\x1bOQ");
			await rig.input("\r");
			own = [];
			await rig.poll();
			clock.now += 3000;
			await rig.poll();
			text = rig.text();
			expect(text).toContain("OTHER NEW ASK?");
			expect(text).toContain(IN_CARD);
			clock.now += 1000;
			await rig.input("\r");
			expect(answers(answer.mock.calls)).toEqual([
				["local/hq", "a", ["Two"]],
				["mini/other", "b", ["One"]],
			]);
		} finally {
			rig.close();
		}
	});

	it("shows a new question, marked, in place of an untouched card while the composer has text", async () => {
		let other: CentralRequest[] = [];
		const { clock, restart } = quietClock();
		const rig = await setup({
			snapshot: () => ({
				chats: [chat({ id: "local/hq", requests: [choice("o", "OLD ASK?", 5)] }), otherAsk({ requests: other })],
				errors: [],
			}),
			restart,
		});
		try {
			await rig.input("\x1bOQ");
			await rig.input("\x1b");
			await rig.input("draft");
			other = [choice("n", "NEW ASK?", 9)];
			await rig.poll();
			clock.now += 10_000;
			await rig.poll();
			const text = rig.text();
			expect(text).toContain("── new question 2 of 2 · SPRILICIM (mini) · F2 to answer ──");
			expect(text).toContain("NEW ASK?");
			expect(text).not.toContain("OLD ASK?");
			expect(text).not.toContain(IN_CARD);
		} finally {
			rig.close();
		}
	});

	it("scrolls a card that was scrolled away back to its control when it takes the keyboard", async () => {
		let requests: CentralRequest[] = [];
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const { clock, restart } = quietClock();
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", requests })], errors: [] }),
			answer,
			restart,
			height: 24,
		});
		try {
			await rig.input("x");
			const options = Array.from({ length: 20 }, (_, index) => `Option ${index}`);
			const title = ["PICK ONE", ...Array.from({ length: 12 }, (_, index) => `Context line ${index}`)].join("\n");
			requests = [{ id: "s", createdAt: 1, kind: "select", title, options }];
			await rig.poll();
			const header = rig
				.text()
				.split("\n")
				.findIndex(line => line.includes("── new question"));
			expect(header).toBeGreaterThan(0);
			for (let index = 0; index < 4; index++) await rig.input(`\x1b[<64;5;${header + 3}M`);
			expect(rig.text()).toContain("PICK ONE");
			expect(rig.text()).not.toContain("Type to search");
			await rig.input("\x7f");
			clock.now += 3000;
			await rig.poll();
			expect(rig.text()).toContain(IN_CARD);
			expect(rig.text()).toContain("❯ Option 0");
			clock.now += 1000;
			await rig.input("\r");
			expect(answers(answer.mock.calls)).toEqual([["local/hq", "s", "Option 0"]]);
		} finally {
			rig.close();
		}
	});

	it("does not give a not-responding chat's question the keyboard until it responds", async () => {
		let unresponsive: string | undefined = "host_timeout";
		const answer = vi.fn(async (..._args: Parameters<CentralTuiHost["answer"]>) => {});
		const { clock, restart } = quietClock();
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq" }), otherAsk({ unresponsive })], errors: [] }),
			answer,
			restart,
		});
		try {
			clock.now += 10_000;
			await rig.poll();
			expect(rig.text()).toContain("── new question · SPRILICIM (mini) · not responding ──");
			expect(rig.text()).not.toContain(IN_CARD);
			unresponsive = undefined;
			await rig.poll();
			expect(rig.text()).toContain("── question · SPRILICIM (mini) · focused ──");
			clock.now += 1000;
			await rig.input("\r");
			expect(answers(answer.mock.calls)).toEqual([["mini/other", "ask9", ["One"]]]);
		} finally {
			rig.close();
		}
	});
});

describe("Central focus flow entries", () => {
	const TIME = String.raw`\d{1,2}:\d{2} [AP]M`;
	const replyAt = (id: string, text: string, at: number): TranscriptEntryLike => {
		const entry = assistant(id, [{ type: "text", text }]);
		if (entry.type === "message") entry.message.timestamp = at;
		return entry;
	};
	const commandWorkspace = {
		statusLines: [],
		usageLines: [],
		canPrompt: true,
		canCommand: true,
		commands: [{ name: "tan", description: "Tan" }],
	};
	const ask = (options: number) => ({
		id: "ask1",
		createdAt: 1,
		kind: "ask" as const,
		questions: [
			{
				id: "eval",
				question: "WHICH EVAL?",
				options: Array.from({ length: options }, (_, index) => ({ label: `Option ${index}` })),
			},
		],
	});

	it("dates each command in the conversation, keeps it across reloads, and later replies render below it", async () => {
		let transcript: TranscriptEntryLike[] = [replyAt("a1", "EARLIER-REPLY", Date.now() - 60_000)];
		let revision = "1";
		const command = vi.fn(async () => "TAN-OUTPUT");
		const rig = await setup({
			snapshot: () => ({
				chats: [chat({ id: "local/hq", requests: [ask(2)], transcriptRevision: revision })],
				errors: [],
			}),
			transcript: async () => transcript,
			command,
			workspace: commandWorkspace,
			height: 50,
		});
		try {
			await rig.input("/dag");
			await rig.input("\r");
			await rig.input("/tan");
			await rig.input("\r");
			expect(command).toHaveBeenCalledTimes(1);
			let text = rig.text();
			expect(text).toMatch(new RegExp(`── ${TIME} · /dag · local, not sent ──`));
			expect(text).toMatch(new RegExp(`── ${TIME} · /tan · ran in the chat ──`));
			// In the flow above the question card, not in a band between the card and the composer.
			const card = text.indexOf("WHICH EVAL?");
			expect(text.indexOf("https://board.example/board/")).toBeLessThan(card);
			expect(text.indexOf("TAN-OUTPUT")).toBeLessThan(card);
			expect(text.slice(card)).not.toContain("ran in the chat");
			// A live reload brings a reply stamped after both commands.
			transcript = [...transcript, replyAt("a2", "LATER-REPLY", Date.now() + 1000)];
			revision = "2";
			await rig.poll();
			await rig.poll();
			text = rig.text();
			const order = ["EARLIER-REPLY", "· /dag ·", "· /tan ·", "TAN-OUTPUT", "LATER-REPLY", "WHICH EVAL?"].map(s =>
				text.indexOf(s),
			);
			expect(order.every(index => index >= 0)).toBe(true);
			expect(order).toEqual([...order].sort((a, b) => a - b));
		} finally {
			rig.close();
		}
	});

	it("jumps to a command's entry and gives it room while a tall question card is open", async () => {
		const longHistory = Array.from({ length: 60 }, (_, index) =>
			assistant(`r${index}`, [{ type: "text", text: `HISTORY LINE ${index}` }]),
		);
		const commands = commandMocks();
		commands.inbox = vi.fn(async () => Array.from({ length: 10 }, (_, index) => `INBOX-ROW-${index}`).join("\n"));
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", requests: [ask(20)] })], errors: [] }),
			transcript: async () => longHistory,
			commands,
			height: 36,
		});
		try {
			// Scrolled up into the history first.
			for (let index = 0; index < 10; index++) await rig.input("\x1b[1;2A");
			expect(rig.text()).not.toContain("HISTORY LINE 59");
			await rig.input("/inbox 10");
			await rig.input("\r");
			const text = rig.text();
			expect(text).toMatch(new RegExp(`── ${TIME} · /inbox 10 · local, not sent ──`));
			for (let index = 0; index < 10; index++) expect(text).toContain(`INBOX-ROW-${index}`);
			expect(text).toContain("WHICH EVAL?");
		} finally {
			rig.close();
		}
	});

	it("enters a question that ended elsewhere in the flow, and F8 shows its kept draft", async () => {
		let requests = [ask(2)];
		const answer = vi.fn(async () => {});
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", requests })], errors: [] }),
			answer,
		});
		try {
			// Down on the empty composer moves into the question (to Option 1): a touched, unsent draft.
			await rig.input("\x1b[B");
			const second = { ...ask(2), id: "ask2", questions: [{ ...ask(2).questions[0]!, question: "SECOND ASK" }] };
			// It ends elsewhere, and the chat asks another question.
			requests = [second];
			await rig.poll();
			let text = rig.text();
			expect(text).toMatch(
				new RegExp(
					`── ${TIME} · TMUX ORCHESTRATION question "WHICH EVAL\\?" ended elsewhere · draft kept: F8 to view ──`,
				),
			);
			expect(text).toContain("SECOND ASK");
			expect(text).not.toContain("draft retained");
			expect(text).not.toContain("draft not sent");
			// F8 shows the kept draft, with its selection, in place of the open card.
			await rig.input("\x1b[19~");
			text = rig.text();
			expect(text).toContain(
				"kept draft · TMUX ORCHESTRATION question ended elsewhere · not sent · F8 back · F9 discard",
			);
			expect(text).toContain("WHICH EVAL?");
			expect(text).toContain("❯ ○ Option 1");
			expect(text).not.toContain("SECOND ASK");
			// Read-only: keys go to the composer, and nothing is answered.
			await rig.input("\r");
			await rig.input("x");
			expect(answer).not.toHaveBeenCalled();
			await rig.input("\x1b[19~");
			text = rig.text();
			expect(text).toContain("SECOND ASK");
			expect(text).not.toContain("kept draft ·");
			// A question that ends untouched leaves a plain entry.
			requests = [];
			await rig.poll();
			text = rig.text();
			expect(text).toMatch(new RegExp(`── ${TIME} · TMUX ORCHESTRATION question "SECOND ASK" ended elsewhere ──`));
			expect(text).not.toContain("draft not sent");
		} finally {
			rig.close();
		}
	});

	it("enters another chat's question that ended in its own pane, naming that chat and its host", async () => {
		let requests = otherAsk().requests;
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq" }), otherAsk({ requests })], errors: [] }),
		});
		try {
			expect(rig.text()).toContain("OTHER ASK?");
			requests = [];
			await rig.poll();
			const text = rig.text();
			expect(text).toMatch(
				new RegExp(`── ${TIME} · SPRILICIM \\(mini\\) question "OTHER ASK\\?" ended elsewhere ──`),
			);
			expect(text).not.toContain("── question");
		} finally {
			rig.close();
		}
	});

	/** A focus view with a kept draft: the focused chat's question was touched, then ended elsewhere. */
	const keptDraft = async (clock: { now: number }) => {
		let requests = [ask(2)];
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", requests })], errors: [] }),
			restart: { restartReady: () => true, now: () => clock.now },
		});
		await rig.input("\x1b[B");
		requests = [];
		await rig.poll();
		expect(rig.text()).toContain("draft kept: F8 to view");
		return rig;
	};

	it("discards a kept draft from the F8 view with F9, and the idle restart then goes ahead", async () => {
		const clock = { now: 1_000_000 };
		const rig = await keptDraft(clock);
		try {
			clock.now += 120_000;
			await rig.poll();
			// Kept and never viewed: it holds the restart.
			expect(rig.exit()).toBeUndefined();
			await rig.input("\x1b[19~");
			expect(rig.text()).toContain("F8/Esc back · F9 discard");
			await rig.input("\x1b[20~");
			const text = rig.text();
			expect(text).toMatch(
				new RegExp(`── ${TIME} · TMUX ORCHESTRATION question "WHICH EVAL\\?" ended elsewhere · draft discarded ──`),
			);
			expect(text).not.toContain("kept draft ·");
			expect(text).not.toContain("Option 1");
			clock.now += 120_000;
			await rig.poll();
			expect(rig.exit()).toBe("restart");
		} finally {
			rig.close();
		}
	});

	it("lets the idle restart drop a kept draft once it was viewed and closed, or after half an hour unviewed", async () => {
		const clock = { now: 1_000_000 };
		let rig = await keptDraft(clock);
		try {
			await rig.input("\x1b[19~");
			clock.now += 120_000;
			await rig.poll();
			// Still on screen: no restart.
			expect(rig.exit()).toBeUndefined();
			await rig.input("\x1b[19~");
			clock.now += 120_000;
			await rig.poll();
			expect(rig.exit()).toBe("restart");
		} finally {
			rig.close();
		}
		rig = await keptDraft(clock);
		try {
			clock.now += 29 * 60_000;
			await rig.poll();
			expect(rig.exit()).toBeUndefined();
			clock.now += 2 * 60_000;
			await rig.poll();
			expect(rig.exit()).toBe("restart");
		} finally {
			rig.close();
		}
	});
});

describe("Central focus copy", () => {
	const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`;
	const drag = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`;
	const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`;
	const history = Array.from({ length: 60 }, (_, index) =>
		assistant(`r${index}`, [{ type: "text", text: `HISTORY LINE ${index}` }]),
	);
	/** Lowest-numbered history line on screen. */
	const topHistory = (text: string) => Math.min(...[...text.matchAll(/HISTORY LINE (\d+)/g)].map(m => Number(m[1])));

	it("copies exactly the plain text of the transcript rows a drag covers, highlighted until the next key", async () => {
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq" })], errors: [] }),
			transcript: async () => [
				assistant("a1", [{ type: "text", text: "- ALPHA **ROW**\n- BETA ROW\n- GAMMA ROW" }]),
			],
		});
		try {
			const lines = rig.text().split("\n");
			const alpha = lines.findIndex(line => line.includes("ALPHA ROW"));
			const beta = lines.findIndex(line => line.includes("BETA ROW"));
			expect(beta).toBe(alpha + 1);
			expect(rig.raw()).not.toContain("\x1b[7m");
			await rig.input(press(0, alpha));
			await rig.input(drag(10, alpha));
			await rig.input(drag(60, beta));
			expect(rig.copy).not.toHaveBeenCalled();
			await rig.input(release(60, beta));
			const expected = `${lines[alpha]!.trimEnd()}\n${lines[beta]!.trimEnd()}`;
			expect(rig.copy.mock.calls).toEqual([[expected]]);
			expect(expected).not.toContain("GAMMA");
			expect(expected).not.toContain("\x1b");
			expect(rig.text()).toContain(`Copied ${expected.length} chars`);
			expect(rig.raw()).toContain("\x1b[7m");
			await rig.input("\x1b[D");
			expect(rig.raw()).not.toContain("\x1b[7m");
		} finally {
			rig.close();
		}
	});

	it("drops the selection when the rows under it change instead of keeping stale text", async () => {
		let transcript = [
			assistant("a0", [{ type: "text", text: "FIRST REPLY" }]),
			assistant("a1", [{ type: "text", text: "- ALPHA ROW\n- BETA ROW" }]),
		];
		let revision = "1";
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq", transcriptRevision: revision })], errors: [] }),
			transcript: async () => transcript,
		});
		try {
			const lines = rig.text().split("\n");
			const alpha = lines.findIndex(line => line.includes("ALPHA ROW"));
			await rig.input(press(0, alpha));
			await rig.input(drag(40, alpha + 1));
			expect(rig.raw()).toContain("\x1b[7m");
			// The capped tail drops its first entry: every row index now holds other text.
			transcript = [transcript[1]!, assistant("a2", [{ type: "text", text: "NEWER REPLY" }])];
			revision = "2";
			await rig.poll();
			await rig.poll();
			expect(rig.text()).toContain("NEWER REPLY");
			expect(rig.raw()).not.toContain("\x1b[7m");
			await rig.input(release(40, alpha + 1));
			expect(rig.copy).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});

	it("treats a press and release on one cell as a click: no copy, and the composer still takes focus", async () => {
		const answer = vi.fn(async () => {});
		const rig = await setup({
			snapshot: () => ({
				chats: [
					chat({
						id: "local/hq",
						requests: [
							{
								id: "ask1",
								createdAt: 1,
								kind: "ask",
								questions: [
									{ id: "q", question: "WHICH EVAL?", options: [{ label: "One" }, { label: "Two" }] },
								],
							},
						],
					}),
				],
				errors: [],
			}),
			answer,
		});
		try {
			await rig.input("\x1b[B");
			expect(rig.text()).toContain("Enter answer");
			const lines = rig.text().split("\n");
			const reply = lines.findIndex(line => line.includes("REPLY-ONE"));
			// A click on the transcript, with a motion report that stays on the pressed cell.
			await rig.input(press(4, reply));
			await rig.input(drag(4, reply));
			await rig.input(release(4, reply));
			expect(rig.copy).not.toHaveBeenCalled();
			expect(rig.raw()).not.toContain("\x1b[7m");
			expect(rig.text()).toContain("Enter answer");
			// The row above the footer hint is the composer's last row.
			const composer = lines.length - 2;
			await rig.input(press(3, composer));
			await rig.input(release(3, composer));
			expect(rig.copy).not.toHaveBeenCalled();
			expect(rig.text()).toContain("Enter send (focus)");
			expect(answer).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});

	it("scrolls the transcript when a drag goes past its top edge and copies the rows it reached", async () => {
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq" })], errors: [] }),
			transcript: async () => history,
			height: 30,
		});
		try {
			const before = topHistory(rig.text());
			const lines = rig.text().split("\n");
			const first = lines.findIndex(line => line.includes(`HISTORY LINE ${before}`));
			// Pressed past the row's text, so the selection runs back to that row's end.
			await rig.input(press(40, first));
			for (let index = 0; index < 3; index++) await rig.input(drag(2, 0));
			const after = topHistory(rig.text());
			expect(after).toBeLessThan(before);
			await rig.input(release(2, 0));
			expect(rig.copy).toHaveBeenCalledTimes(1);
			const copied = rig.copy.mock.calls[0]![0];
			expect(copied).toContain(`HISTORY LINE ${after}`);
			expect(copied).toContain(`HISTORY LINE ${before}`);
			expect(copied).not.toContain(`HISTORY LINE ${before + 1}`);
		} finally {
			rig.close();
		}
	});

	it("still scrolls the transcript with the wheel", async () => {
		const rig = await setup({
			snapshot: () => ({ chats: [chat({ id: "local/hq" })], errors: [] }),
			transcript: async () => history,
			height: 30,
		});
		try {
			const before = topHistory(rig.text());
			for (let index = 0; index < 3; index++) await rig.input("\x1b[<64;10;8M");
			expect(topHistory(rig.text())).toBeLessThan(before);
			expect(rig.copy).not.toHaveBeenCalled();
		} finally {
			rig.close();
		}
	});

	it("copies the latest reply's text with Ctrl+X", async () => {
		const rig = await setup({ snapshot: () => ({ chats: [chat({ id: "local/hq" })], errors: [] }) });
		try {
			expect(rig.text()).toContain("drag to copy · Ctrl+X copy reply");
			await rig.input("\x18");
			expect(rig.copy.mock.calls).toEqual([["REPLY-ONE\n\nREPLY-TWO **bold**"]]);
			expect(rig.text()).toContain("Copied 29 chars");
		} finally {
			rig.close();
		}
	});

	it("selects whole wide characters by cell and trims each row's trailing padding", () => {
		expect(selectCells("ab中文cd", 3, 5)).toEqual({ from: 2, to: 6, text: "中文" });
		expect(selectCells("ab中文cd", 6, 7)).toEqual({ from: 6, to: 7, text: "c" });
		const rows = [" \x1b[1mone\x1b[0m   ", "\ttwo  "];
		expect(selectionText(rows, { line: 0, col: 2 }, { line: 1, col: Number.POSITIVE_INFINITY })).toBe(
			`ne\n${" ".repeat(DEFAULT_TAB_WIDTH)}two`,
		);
	});
});
