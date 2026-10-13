import { beforeAll, expect, it, spyOn } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

function harness(watermark = true) {
	const terminal = new VirtualTerminal(80, 30);
	const writes = spyOn(terminal, "write");
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		watermark,
		tuiOptions: { renderScheduler: scheduler },
		preferences: {
			quiet: true,
			spellingTypoDetection: false,
			spellingAutocomplete: "off",
			spellingAutocorrect: false,
		},
	});
	const transcript = new TranscriptContainer();
	const input = { render: () => ["INPUT"], getClickAgentAtRow: () => "input-owner" };
	composer.setRuntimeChildren([transcript, input]);
	return { terminal, writes, scheduler, composer, transcript };
}

it("signals at deferred prepaint, survives adoption, and clears on suspend and final stop", async () => {
	const h = harness();
	const signals = () =>
		h.writes.mock.calls.map(([data]) => data).filter(data => data.includes("omp_watermark_instance="));
	try {
		expect(signals()).toEqual([]);
		h.composer.start({ playWelcomeIntro: false, deferInput: true });
		const first = signals()[0]!;
		const owner = Buffer.from(
			first.slice("\x1b]1337;SetUserVar=omp_watermark_instance=".length, -1),
			"base64",
		).toString();
		expect(signals()).toHaveLength(1);
		expect(owner).toMatch(new RegExp(`^${process.pid}-[0-9a-f-]{36}$`));
		h.composer.transfer();
		h.composer.stop(); // The transferred TUI, not the bootstrap owner, controls its lifetime.
		h.composer.ui.enableInput();
		await h.scheduler.settle(h.terminal);
		h.composer.ui.requestRender(true);
		await h.scheduler.settle(h.terminal);
		expect(signals()).toEqual([first]);
		h.composer.ui.stop();
		expect(signals()).toEqual([first, "\x1b]1337;SetUserVar=omp_watermark_instance=\x07"]);
		h.composer.ui.start();
		await h.scheduler.settle(h.terminal);
		expect(signals().at(-1)).toBe(first);
		h.composer.ui.stop();
		h.composer.ui.stop();
		expect(signals()).toHaveLength(4);
	} finally {
		h.composer.ui.stop();
		h.writes.mockRestore();
	}
});

it("does not reserve rows or change normal and resize frame geometry", async () => {
	const marked = harness();
	const plain = harness(false);
	try {
		for (const h of [marked, plain]) h.composer.start({ playWelcomeIntro: false });
		for (const [columns, rows] of [
			[80, 30],
			[8, 4],
			[4, 1],
		]) {
			for (const h of [marked, plain]) {
				h.terminal.resize(columns!, rows!);
				await h.scheduler.settle(h.terminal);
			}
			const viewport = { columns: columns!, rows: rows! };
			expect(marked.composer.renderFrame(viewport)).toEqual(plain.composer.renderFrame(viewport));
			expect(marked.composer.renderResizeFrame(viewport)).toEqual(plain.composer.renderResizeFrame(viewport));
		}
		expect(marked.writes.mock.calls.some(([data]) => data.includes("\x1b_G"))).toBe(false);
	} finally {
		for (const h of [marked, plain]) {
			h.composer.stop();
			h.writes.mockRestore();
		}
	}
});

it("preserves native transcript history and live click ownership without a decorative row", async () => {
	const h = harness();
	try {
		h.composer.start({ playWelcomeIntro: false });
		for (let i = 0; i < 65; i++) {
			h.transcript.addChild(new Text(`Chat row ${i}`, 0, 0));
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		const all = h.terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		expect(all.filter(row => row.startsWith("Chat row "))).toEqual(
			Array.from({ length: 65 }, (_, i) => `Chat row ${i}`),
		);
		expect(h.terminal.getViewport()[29]?.trim()).toBe("INPUT");
		expect(h.composer.viewportClickCandidates(29)).toEqual(["input-owner"]);
	} finally {
		h.composer.stop();
		h.writes.mockRestore();
	}
});

it("gives fullscreen panels row zero and forwards presses, drags, releases and wheels unchanged", async () => {
	const h = harness();
	try {
		h.composer.start({ playWelcomeIntro: false });
		const received: string[] = [];
		h.composer.ui.showOverlay(
			{ render: () => ["PANEL"], handleInput: data => received.push(data) },
			{ fullscreen: true, width: "100%", maxHeight: "100%", anchor: "top-left" },
		);
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport()[0]?.trim()).toBe("PANEL");
		const events = ["\x1b[<4;3;2M", "\x1b[<36;3;1M", "\x1b[<4;3;1m", "\x1b[<4;3;1M", "\x1b[<64;3;1M"];
		for (const event of events) h.terminal.sendInput(event);
		expect(received).toEqual(events);
	} finally {
		h.composer.stop();
		h.writes.mockRestore();
	}
});
