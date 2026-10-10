import { beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { getCellDimensions, ImageProtocol, setCellDimensions, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { expandedToolRows } from "@oh-my-pi/pi-tui/render/utils";
import { styleTerminalRow } from "@oh-my-pi/pi-tui/tools/terminal-output";

const SEED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
// Tests deliberately override the readonly detected capability, as image-render.test.ts does.
const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };

beforeAll(async () => {
	await initTheme();
});

describe("individually expanded image cards", () => {
	for (const [label, protocol] of [
		["iTerm2", ImageProtocol.Iterm2],
		["Kitty", ImageProtocol.Kitty],
	] as const) {
		it(`preserves ${label} placement and reserved height in completed image-only Bash`, async () => {
			const originalProtocol = TERMINAL.imageProtocol;
			const originalCells = { ...getCellDimensions() };
			const originalGraphics = { ...getKittyGraphics() };
			const originalTmux = Bun.env.TMUX;
			try {
				delete Bun.env.TMUX;
				terminal.imageProtocol = protocol;
				setCellDimensions({ widthPx: 10, heightPx: 10 });
				setKittyGraphics({ unicodePlaceholders: false });
				const data = await new Bun.Image(Buffer.from(SEED_PNG, "base64")).resize(100, 100).png().toBase64();
				const card = new BashExecutionComponent("draw image", ui);
				card.setComplete(0, false, { output: "", images: [{ type: "image", data, mimeType: "image/png" }] });
				card.setExpanded(true);
				const globalRows = card.render(60);
				const placement = globalRows.findIndex(row => TERMINAL.isImageLine(row));
				expect(placement).toBeGreaterThan(0);
				let start = placement;
				while (start > 0 && globalRows[start - 1] === "\x1b[0m") start--;
				const imageRows = globalRows.slice(start, placement + 1);
				expect(imageRows.length).toBeGreaterThan(1);
				expect(imageRows.at(-1)).toContain(`\x1b[${imageRows.length - 1}A`);
				card.setExpanded(false);
				card.render(60);
				expect(card.toggleClickExpansion()).toBe(true);
				const expanded = card.render(60);
				const expandedPlacement = expanded.findIndex(row => TERMINAL.isImageLine(row));
				expect(expandedPlacement).toBe(placement);
				expect(expanded.slice(start, expandedPlacement + 1)).toEqual(imageRows);
			} finally {
				terminal.imageProtocol = originalProtocol;
				setCellDimensions(originalCells);
				setKittyGraphics(originalGraphics);
				if (originalTmux === undefined) delete Bun.env.TMUX;
				else Bun.env.TMUX = originalTmux;
			}
		});
	}
});

describe("expanded card bottom spacing", () => {
	it("paints content without appending a blank row", () => {
		const rows = expandedToolRows(theme, ["first", "", "last"], 20);
		expect(rows.map(row => Bun.stripANSI(row).trimEnd())).toEqual(["first", "", "last"]);
	});

	it("preserves styled blank output and image reservation rows", () => {
		const blank = "\x1b[39m  ";
		const reserved = "\x1b[0m";
		const rows = expandedToolRows(theme, ["output", blank, reserved], 20);
		expect(rows).toHaveLength(3);
		expect(Bun.stripANSI(rows[1]!)).toBe(" ".repeat(20));
		expect(rows[2]).toBe(reserved);
	});
});

describe("expanded card combined SGR backgrounds", () => {
	it("removes a real PTY combined background without losing bold or foreground", () => {
		const row = styleTerminalRow("\x1b[1;38;2;255;48;41;48;2;255;0;0mpty\x1b[0m", "");
		expect(row).toContain("48;2;255;0;0");
		const rendered = expandedToolRows(theme, [row], 20)[0]!;
		expect(rendered).toContain("\x1b[1;38;2;255;48;41m");
		expect(rendered).not.toContain("48;2;255;0;0");
	});

	it("preserves colon foreground and attributes while removing only backgrounds", () => {
		for (const background of ["48:2::255:0:0", "48:5:1", "48;5;1", "41", "101", "49"]) {
			const row = `\x1b[1;38:2::48:41:100;${background};4:3mtext`;
			const rendered = expandedToolRows(theme, [row], 20)[0]!;
			expect(rendered).toContain("\x1b[1;38:2::48:41:100;4:3mtext");
		}
	});
});
