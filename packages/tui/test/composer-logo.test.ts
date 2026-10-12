import { beforeAll, expect, it } from "bun:test";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

function harness() {
	const terminal = new VirtualTerminal(80, 30);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		ravensLogo: true,
		tuiOptions: { renderScheduler: scheduler },
		preferences: {
			quiet: true,
			spellingTypoDetection: false,
			spellingAutocomplete: "off",
			spellingAutocorrect: false,
		},
	});
	const transcript = new TranscriptContainer();
	const input = {
		render: () => ["INPUT"],
		getClickAgentAtRow: () => "input-owner",
	};
	composer.setRuntimeChildren([transcript, input]);
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, transcript };
}

it("keeps the logo out of history while preserving every retired chat row", async () => {
	const h = harness();
	try {
		for (let i = 0; i < 65; i++) {
			h.transcript.addChild(new Text(`Chat row ${i}`, 0, 0));
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		const all = h.terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		expect(all.filter(row => row.startsWith("Chat row "))).toEqual(
			Array.from({ length: 65 }, (_, i) => `Chat row ${i}`),
		);
		expect(all.slice(0, -30).some(row => /[▀▄]/u.test(row))).toBe(false);
		expect(h.terminal.getViewport()[0]).toMatch(/[▀▄]/u);
		expect(h.terminal.getViewport()[29]?.trim()).toBe("INPUT");
		expect(h.composer.viewportClickCandidates(29)).toEqual(["input-owner"]);
		expect(h.composer.viewportClickCandidates(0)).toEqual([]);
	} finally {
		h.composer.stop();
	}
});

it.each([false, true])(
	"reserves the header above a modal (alternate buffer: %s) and restores input ownership",
	async fullscreen => {
		const h = harness();
		try {
			await h.scheduler.settle(h.terminal);
			const header = h.terminal.getViewport().slice(0, h.composer.getViewportTopInset());
			const modal = h.composer.ui.showOverlay(
				new Text(Array.from({ length: 50 }, (_, i) => `Modal row ${i}`).join("\n"), 0, 0),
				{
					width: "100%",
					maxHeight: "100%",
					anchor: "top-left",
					fullscreen,
				},
			);
			await h.scheduler.settle(h.terminal);
			expect(h.terminal.getViewport().slice(0, header.length)).toEqual(header);
			expect(h.terminal.getViewport()[header.length]?.trim()).toBe("Modal row 0");
			modal.hide();
			await h.scheduler.settle(h.terminal);
			expect(h.terminal.getViewport()[29]?.trim()).toBe("INPUT");
			expect(h.composer.viewportClickCandidates(29)).toEqual(["input-owner"]);
		} finally {
			h.composer.stop();
		}
	},
);

it("shrinks the header during resize without clipping the input or stealing its clicks", async () => {
	const h = harness();
	try {
		await h.scheduler.settle(h.terminal);
		for (const [columns, rows] of [
			[16, 16],
			[8, 8],
			[4, 4],
			[80, 30],
		]) {
			h.terminal.resize(columns!, rows!);
			await h.scheduler.settle(h.terminal);
			const frame = h.composer.renderFrame({ columns: columns!, rows: rows! });
			expect(frame.viewport).toHaveLength(rows!);
			expect(frame.viewport.at(-1)).toBe("INPUT");
			expect(h.composer.viewportClickCandidates(rows! - 1)).toEqual(["input-owner"]);
			expect(h.composer.viewportClickCandidates(0)).toEqual([]);
			expect(h.composer.getViewportTopInset()).toBeLessThan(rows!);
			expect(h.composer.renderResizeFrame({ columns: columns!, rows: rows! }).at(-1)).toBe("INPUT");
		}
	} finally {
		h.composer.stop();
	}
});

it("refills retired rows below the logo after replay and retains them across later paints", async () => {
	const h = harness();
	try {
		const blocks = Array.from({ length: 10 }, (_, i) => new Text(`Retired row ${i}`, 0, 0));
		for (const block of blocks) h.transcript.addChild(block);
		h.composer.setRuntimeChildren([h.transcript, new Text(Array(27).fill("Expanded tool").join("\n"), 0, 0)]);
		await h.scheduler.settle(h.terminal);
		h.composer.setRuntimeChildren([h.transcript, new Text("INPUT", 0, 0)]);
		h.composer.ui.resetDisplay();
		await h.scheduler.settle(h.terminal);
		const expected = Array.from({ length: 10 }, (_, i) => `Retired row ${i}`);
		const visible = () =>
			h.terminal
				.getViewport()
				.map(row => row.trim())
				.filter(row => row.startsWith("Retired row "));
		expect(visible()).toEqual(expected);
		const firstRow = h.terminal.getViewport().findIndex(row => row.trim() === "Retired row 0");
		expect(h.composer.ui.getScreenHistoryOwner(firstRow)).toBe(blocks[0]);
		const overlay = h.composer.ui.showOverlay(new Text("PICKER", 0, 0), { width: "100%" });
		await h.scheduler.settle(h.terminal);
		overlay.hide();
		await h.scheduler.settle(h.terminal);
		expect(visible()).toEqual(expected);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(visible()).toEqual(expected);
		h.transcript.addChild(new Text("Retired row 10", 0, 0));
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(visible()).toEqual([...expected, "Retired row 10"]);
		for (let i = 11; i < 45; i++) h.transcript.addChild(new Text(`Retired row ${i}`, 0, 0));
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(
			h.terminal
				.getScrollBuffer()
				.map(row => row.trim())
				.filter(row => row.startsWith("Retired row ")),
		).toEqual(Array.from({ length: 45 }, (_, i) => `Retired row ${i}`));
		expect(h.terminal.getViewport()[0]).toMatch(/[▀▄]/u);
	} finally {
		h.composer.stop();
	}
});
