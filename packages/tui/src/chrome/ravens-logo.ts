import { RAVENS_PALETTE, RAVENS_PIXELS } from "./ravens-logo-data";

const RESET = "\x1b[0m";
const COLORS = RAVENS_PALETTE.map(hex =>
	[0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(";"),
);

function rasterRows(pixels: readonly string[]): string[] {
	const rows: string[] = [];
	for (let y = 0; y < pixels.length; y += 2) {
		let row = "";
		for (let x = 0; x < pixels[y]!.length; x++) {
			const top = pixels[y]![x]!;
			const bottom = pixels[y + 1]?.[x] ?? ".";
			if (top === "." && bottom === ".") row += `${RESET} `;
			else if (top === ".") row += `\x1b[49;38;2;${COLORS[Number(bottom)]}m▄`;
			else if (bottom === ".") row += `\x1b[49;38;2;${COLORS[Number(top)]}m▀`;
			else row += `\x1b[38;2;${COLORS[Number(top)]};48;2;${COLORS[Number(bottom)]}m▀`;
		}
		rows.push(row + RESET);
	}
	return rows;
}

const RASTERS = ([24, 16, 8] as const).map(width => ({
	width,
	rows: rasterRows(RAVENS_PIXELS[`${width}`]),
}));

/** Cell artwork works over SSH/tmux without graphics protocols or external assets. */
export class RavensLogo {
	#width = -1;
	#height = -1;
	#rows: readonly string[] = [];

	render(width: number, maxRows: number): readonly string[] {
		if (width === this.#width && maxRows === this.#height) return this.#rows;
		this.#width = width;
		this.#height = maxRows;
		const raster = RASTERS.find(candidate => candidate.width <= width && candidate.rows.length <= maxRows);
		if (raster) {
			const padding = " ".repeat(width - raster.width);
			this.#rows = raster.rows.map(row => padding + row);
		} else if (width > 0 && maxRows > 0) {
			const label = width >= 3 ? "BAL" : "B";
			this.#rows = [`${" ".repeat(width - label.length)}\x1b[38;2;158;124;12m${label}${RESET}`];
		} else this.#rows = [];
		return this.#rows;
	}
}
