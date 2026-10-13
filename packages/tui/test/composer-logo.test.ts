import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, KITTY_PLACEHOLDER, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { getCellDimensions, ImageProtocol, setCellDimensions, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { RAVENS_LOGO_DIMENSIONS, RAVENS_LOGO_PNG_BASE64 } from "@oh-my-pi/pi-tui/chrome/ravens-logo-data";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

const terminalInfo = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
let previousProtocol: ImageProtocol | null;
let previousGraphics: ReturnType<typeof getKittyGraphics>;
let previousCells: ReturnType<typeof getCellDimensions>;
beforeEach(() => {
	previousProtocol = terminalInfo.imageProtocol;
	previousGraphics = { ...getKittyGraphics() };
	previousCells = { ...getCellDimensions() };
	terminalInfo.imageProtocol = ImageProtocol.Kitty;
	setKittyGraphics({ unicodePlaceholders: true });
	setCellDimensions({ widthPx: 10, heightPx: 20 });
});
afterEach(() => {
	terminalInfo.imageProtocol = previousProtocol;
	setKittyGraphics(previousGraphics);
	setCellDimensions(previousCells);
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
		expect(all.slice(0, -30).some(row => row.includes(KITTY_PLACEHOLDER))).toBe(false);
		expect(h.terminal.getViewport()[0]).toContain(KITTY_PLACEHOLDER);
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
		expect(h.terminal.getViewport()[0]).toContain(KITTY_PLACEHOLDER);
	} finally {
		h.composer.stop();
	}
});

it("delivers fullscreen drags and releases over the header without accepting new presses", async () => {
	const h = harness();
	try {
		const received: string[] = [];
		h.composer.ui.showOverlay(
			{ render: () => ["PANEL"], handleInput: data => received.push(data) },
			{
				fullscreen: true,
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
			},
		);
		await h.scheduler.settle(h.terminal);
		const inset = h.composer.getViewportTopInset();
		h.terminal.sendInput(`\x1b[<4;3;${inset + 2}M`);
		h.terminal.sendInput("\x1b[<36;3;1M");
		h.terminal.sendInput("\x1b[<4;3;1m");
		h.terminal.sendInput("\x1b[<4;3;1M");
		h.terminal.sendInput("\x1b[<64;3;1M");
		expect(received).toEqual(["\x1b[<4;3;2M", "\x1b[<36;3;1M", "\x1b[<4;3;1m"]);
	} finally {
		h.composer.stop();
	}
});

it.each([false, true])("retires short replay chrome on stop (fullscreen overlay: %s)", async fullscreen => {
	const h = harness();
	try {
		for (let i = 0; i < 10; i++) h.transcript.addChild(new Text(`Stop row ${i}`, 0, 0));
		h.composer.setRuntimeChildren([h.transcript, new Text(Array(27).fill("Expanded tool").join("\n"), 0, 0)]);
		await h.scheduler.settle(h.terminal);
		h.composer.setRuntimeChildren([h.transcript, new Text("INPUT", 0, 0)]);
		h.composer.ui.resetDisplay();
		await h.scheduler.settle(h.terminal);
		if (fullscreen) {
			h.composer.ui.showOverlay(new Text("PANEL", 0, 0), { fullscreen: true });
			await h.scheduler.settle(h.terminal);
		}
		h.composer.stop();
		await h.terminal.flush();
		const rows = h.terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		expect(rows.filter(row => row.startsWith("Stop row "))).toEqual(
			Array.from({ length: 10 }, (_, i) => `Stop row ${i}`),
		);
		expect(rows.some(row => row.includes(KITTY_PLACEHOLDER))).toBe(false);
		expect(rows.some(row => row.includes("PANEL"))).toBe(false);
	} finally {
		h.composer.stop();
	}
});

it("removes logo chrome on empty stop without a history batch", async () => {
	const h = harness();
	await h.scheduler.settle(h.terminal);
	h.composer.stop();
	await h.terminal.flush();
	expect(h.terminal.getScrollBuffer().some(row => row.includes(KITTY_PLACEHOLDER))).toBe(false);
	expect(h.terminal.getScrollBuffer().filter(row => row.trim() === "INPUT")).toHaveLength(1);
});

it("preserves long retained rows when preserve-mode resize narrows the viewport", async () => {
	const h = harness();
	try {
		h.composer.ui.setResizeScrollback("preserve");
		const text = "Retained:" + "0123456789".repeat(6) + ":END";
		h.transcript.addChild(new Text(text, 0, 0));
		h.composer.setRuntimeChildren([h.transcript, new Text(Array(27).fill("Expanded tool").join("\n"), 0, 0)]);
		await h.scheduler.settle(h.terminal);
		h.composer.setRuntimeChildren([h.transcript, new Text("INPUT", 0, 0)]);
		h.composer.ui.resetDisplay();
		await h.scheduler.settle(h.terminal);
		h.terminal.resize(30, 30);
		await h.scheduler.settle(h.terminal);
		const visible = h.terminal
			.getViewport()
			.map(row => Bun.stripANSI(row).trimEnd())
			.join("");
		expect(visible).toContain(text);
	} finally {
		h.composer.stop();
	}
});

it.each(["preserve", "append"] as const)(
	"blanks logo copies a %s-mode resize strands in native history while the top row stays live",
	async mode => {
		const h = harness();
		try {
			h.composer.ui.setResizeScrollback(mode);
			for (let i = 0; i < 40; i++) h.transcript.addChild(new Text(`Chat row ${i}`, 0, 0));
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			// Shrinks push the painted top row into native history; the width
			// change also reflows it there. No escape sequence can erase history.
			for (const [columns, rows] of [
				[80, 24],
				[60, 20],
				[80, 30],
			] as const) {
				h.terminal.resize(columns, rows);
				await h.scheduler.settle(h.terminal);
				await h.scheduler.advance(h.terminal, 1000);
				await h.scheduler.settle(h.terminal);
			}
			const live = new Set(h.terminal.graphicsPlacements().map(placement => placement.imageId));
			// Placeholder cells name their image in a truecolor foreground.
			const namedImages = (row: number) =>
				h.terminal.getViewport()[row]!.includes(KITTY_PLACEHOLDER)
					? h.terminal
							.getViewportRowForegroundValues(row)
							.filter(word => word >>> 24 === 2)
							.map(word => word & 0xffffff)
					: [];
			const top = namedImages(0);
			expect(top.length).toBeGreaterThan(0);
			expect(top.every(id => live.has(id))).toBe(true);
			expect(h.terminal.getViewport()[29]?.trim()).toBe("INPUT");

			const { baseY } = h.terminal.getBufferPosition();
			h.terminal.scrollLines(-baseY);
			const stranded: number[] = [];
			for (let start = 0; start < baseY; start += 30) {
				for (let row = 0; row < Math.min(30, baseY - start); row++) stranded.push(...namedImages(row));
				h.terminal.scrollLines(30);
			}
			expect(stranded.length).toBeGreaterThan(0);
			expect(stranded.some(id => live.has(id))).toBe(false);

			h.composer.stop();
			expect(h.terminal.graphicsPlacements()).toEqual([]);
		} finally {
			h.composer.stop();
		}
	},
);

it("limits the smooth logo to one row and four columns without using a chat-image slot", async () => {
	const h = harness();
	try {
		h.composer.ui.imageBudget.setCap(1);
		const image = new Image(
			RAVENS_LOGO_PNG_BASE64,
			"image/png",
			{ fallbackColor: text => text },
			{
				budget: h.composer.ui.imageBudget,
				imageKey: "chat-image",
				maxHeightCells: 3,
			},
			RAVENS_LOGO_DIMENSIONS,
		);
		h.composer.setRuntimeChildren([image, new Text("INPUT", 0, 0)]);
		await h.scheduler.settle(h.terminal);
		const header = h.composer.renderViewportTop({ columns: 80, rows: 30 });
		expect(header).toHaveLength(1);
		expect(header[0]!.split(KITTY_PLACEHOLDER).length - 1).toBeLessThanOrEqual(4);
		expect(header[0]).not.toMatch(/[▀▄]/u);
		expect(image.debugState().suppressed).toBe(false);
		expect(h.terminal.getViewport().filter(row => row.includes(KITTY_PLACEHOLDER)).length).toBeGreaterThan(1);
	} finally {
		h.composer.stop();
	}
});

it.each([null, ImageProtocol.Kitty])("does not reserve logo space without safe image support (%s)", async protocol => {
	terminalInfo.imageProtocol = protocol;
	setKittyGraphics({ unicodePlaceholders: false });
	const h = harness();
	try {
		await h.scheduler.settle(h.terminal);
		const frame = h.composer.renderFrame({ columns: 80, rows: 30 });
		expect(h.composer.getViewportTopInset()).toBe(0);
		expect(frame.viewport.length).toBeLessThan(30);
		expect(frame.viewport.join("")).not.toContain(KITTY_PLACEHOLDER);
		expect(frame.viewport.join("")).not.toMatch(/[▀▄]/u);
		expect(frame.viewport.at(-1)).toBe("INPUT");
	} finally {
		h.composer.stop();
	}
});
