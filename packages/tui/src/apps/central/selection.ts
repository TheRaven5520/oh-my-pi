/**
 * Mouse text selection over rendered rows, for fullscreen views whose mouse
 * capture keeps the terminal and tmux from selecting. Columns are terminal
 * cells; a wide character partly covered by the drag is taken whole.
 */
import {
	getSegmenter,
	isOsc66Line,
	replaceTabs,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "../../utils";

/** A cell position in a region's logical rows; `col` may be `Infinity` (end of row). */
export interface SelectionPoint {
	line: number;
	col: number;
}

/** Plain text a rendered row shows: no SGR, OSC or APC sequences, tabs expanded as viewports draw them. */
export function plainRow(line: string): string {
	return replaceTabs(stripTerminalSequences(line));
}

/** Start and end of a selection in reading order. */
export function orderedSelection(a: SelectionPoint, b: SelectionPoint): [SelectionPoint, SelectionPoint] {
	return a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a];
}

/**
 * Cells `[from, to)` of `plain`, widened to whole graphemes: the snapped range
 * and the text it covers. Empty when no grapheme starts before `to` and ends after `from`.
 */
export function selectCells(plain: string, from: number, to: number): { from: number; to: number; text: string } {
	let col = 0;
	let start = -1;
	let end = 0;
	let text = "";
	for (const { segment } of getSegmenter().segment(plain)) {
		if (col >= to) break;
		const width = visibleWidth(segment);
		if (col + Math.max(width, 1) > from) {
			if (start < 0) start = col;
			end = col + width;
			text += segment;
		}
		col += width;
	}
	return start < 0 ? { from, to: from, text: "" } : { from: start, to: end, text };
}

/** Selected cells of logical row `line` (inclusive end cell), or undefined when the row is outside the selection. */
export function rowSelection(
	line: number,
	start: SelectionPoint,
	end: SelectionPoint,
	plain: string,
	scaled: boolean,
): { from: number; to: number; text: string } | undefined {
	if (line < start.line || line > end.line) return undefined;
	// Text sizing (OSC 66) draws cells wider than its text; such a row is taken whole.
	if (scaled) return { from: 0, to: 0, text: plain };
	const from = line === start.line ? start.col : 0;
	const to = line === end.line ? end.col + 1 : Number.POSITIVE_INFINITY;
	return selectCells(plain, from, to);
}

/** The copied text: each row's selected cells without trailing padding, joined by newlines. */
export function selectionText(lines: readonly string[], anchor: SelectionPoint, head: SelectionPoint): string {
	const [start, end] = orderedSelection(anchor, head);
	const rows: string[] = [];
	for (let line = start.line; line <= end.line; line++) {
		const source = lines[line];
		if (source === undefined) continue;
		rows.push((rowSelection(line, start, end, plainRow(source), isOsc66Line(source))?.text ?? "").trimEnd());
	}
	return rows.join("\n");
}

/** `row` with cells `[from, to)` drawn in reverse video as `text`; styling outside the range is kept. */
export function highlightRow(row: string, from: number, to: number, text: string): string {
	if (to <= from || isOsc66Line(row)) return row;
	const before = sliceByColumn(row, 0, from, true);
	const after = sliceByColumn(row, to, Math.max(0, visibleWidth(row) - to));
	return `${before}\x1b[0m\x1b[7m${text}\x1b[27m\x1b[0m${after}`;
}
