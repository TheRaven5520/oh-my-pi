import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Text } from "@oh-my-pi/pi-tui";
import { TERMINAL, type TerminalId } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});
const terminalInfo = TERMINAL as unknown as { id: TerminalId };
let previousId: TerminalId;
beforeEach(() => {
	previousId = terminalInfo.id;
	terminalInfo.id = "kitty";
});
afterEach(() => {
	terminalInfo.id = previousId;
});

it.each([
	[100, 20, false],
	[50, 20, false],
	[100, 20, true],
	[50, 20, true],
] as const)(
	"fills the conversation after Kitty tiles to %ix%i and grows back (pinned: %s)",
	async (columns, rows, pinned) => {
		// Use Kitty's real resize behavior, not the fixture's default xterm-style
		// history pull-down, which masks the height-only regression.
		const terminal = new VirtualTerminal(100, 40, undefined, false);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: {
				quiet: true,
				composerShape: "pi",
				resizeScrollback: "rebuild",
				spellingAutocomplete: "off",
				spellingTypoDetection: false,
				spellingAutocorrect: false,
			},
		});
		const transcript = new TranscriptContainer();
		const history = Array.from(
			{ length: 100 },
			(_, index) => `History row ${index}: conversation content that wraps when AeroSpace narrows the Kitty window`,
		);
		for (const row of history) transcript.addChild(new Text(row, 0, 0));
		composer.setRuntimeChildren([transcript, composer.editor], { transient: [composer.editor] });
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			const initial = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			terminal.resize(columns, rows);
			await scheduler.advance(terminal, 500);
			if (pinned) composer.pinInputToBottom();
			terminal.resize(100, 40);
			await scheduler.advance(terminal, 500);
			const viewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(viewport).toEqual(initial);
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd())).toEqual(initial);
			const all = terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => row.startsWith("History row "));
			expect(all).toEqual(history);
		} finally {
			composer.stop();
		}
	},
);
