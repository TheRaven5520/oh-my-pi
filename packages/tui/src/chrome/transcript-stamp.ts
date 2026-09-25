/**
 * Right-aligned timestamp labels for transcript rows. A label only ever
 * replaces trailing padding (inside a full-width card, the padding before its
 * right border): content, borders, hyperlinks and zero-width markers (OSC 133
 * prompt marks, OSC 8 links, SGR background runs) stay byte-identical and in
 * order, and a row without room for the label is left alone.
 */
import { visibleWidth } from "../utils";

/** The row's trailing region: only spaces and zero-width escapes (SGR, OSC) up to the end. */
const TRAILING_REGION = /(?:\x1b\[[0-9;:]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)| )*$/;
/** One token of that region: an escape, or a single space column. */
const REGION_TOKEN = /\x1b\[[0-9;:]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)| /g;
/** Minimum blank columns kept between content and the label. */
const MIN_GAP = 2;
/** Right borders of boxed cards (bash, eval, ...): the label goes just inside them. */
const CARD_RIGHT_BORDERS = new Set(["│", "┃", "║"]);

/** Where the row's trailing region starts, and how many space columns it holds. */
function trailingRegion(row: string): { start: number; spaces: number } {
	const start = TRAILING_REGION.exec(row)?.index ?? row.length;
	let spaces = 0;
	for (let index = start; index < row.length; index++) if (row[index] === " ") spaces++;
	return { start, spaces };
}

/**
 * The part of `row` a label may be written into (`head`), what follows it
 * unchanged (`tail`), and the column the label ends one column before. For a
 * full-width card row that is its right border; otherwise the row's width.
 */
function labelSlot(row: string, width: number): { head: string; tail: string; edge: number } {
	const plain = Bun.stripANSI(row).trimEnd();
	const border = plain.at(-1);
	if (border !== undefined && CARD_RIGHT_BORDERS.has(border) && plain.at(-2) === " ") {
		const edge = visibleWidth(plain) - 1;
		// Narrower boxes (e.g. a Markdown table) are content, not a card frame.
		if (edge >= width - 2) {
			const index = row.lastIndexOf(border);
			return { head: row.slice(0, index), tail: row.slice(index), edge };
		}
	}
	return { head: row, tail: "", edge: width };
}

/** Whether `row` has room for a `labelWidth` label right-aligned in its slot. */
export function hasLabelRoom(row: string, width: number, labelWidth: number): boolean {
	const { head, edge } = labelSlot(row, width);
	const content = visibleWidth(head) - trailingRegion(head).spaces;
	return edge - 1 - labelWidth - content >= MIN_GAP;
}

/**
 * `row` with `styledLabel` (visible width `labelWidth`) right-aligned one
 * column in from `width` (or from a full-width card's right border), written
 * over the trailing spaces; undefined when the content leaves no room.
 */
export function stampRow(row: string, width: number, styledLabel: string, labelWidth: number): string | undefined {
	const { head, tail, edge } = labelSlot(row, width);
	const { start: regionStart, spaces } = trailingRegion(head);
	const content = visibleWidth(head) - spaces;
	const labelStart = edge - 1 - labelWidth;
	if (labelStart - content < MIN_GAP) return undefined;

	// Replay the region column by column: escapes keep their place, the spaces
	// under the label are dropped, and the label goes in at its column.
	let out = head.slice(0, regionStart);
	let column = content;
	let placed = false;
	for (const token of head.slice(regionStart).match(REGION_TOKEN) ?? []) {
		if (token !== " ") {
			out += token;
			continue;
		}
		if (!placed && column === labelStart) {
			out += styledLabel;
			placed = true;
		}
		if (!(placed && column < labelStart + labelWidth)) out += " ";
		column++;
	}
	// The padding ended before the label's column: pad after the row's own escapes.
	if (!placed) out += `${" ".repeat(labelStart - column)}${styledLabel}`;
	return out + tail;
}

/** Whether a row holds no visible content (a separator). */
export function isBlankRow(row: string): boolean {
	return !/\S/.test(Bun.stripANSI(row));
}

/**
 * Index of the first non-blank row among the top `candidates` with room for
 * the label. The choice depends only on that row and the rows above it.
 */
export function findLabelRow(
	rows: readonly string[],
	width: number,
	labelWidth: number,
	candidates: number,
): number | undefined {
	const limit = Math.min(rows.length, candidates);
	for (let index = 0; index < limit; index++) {
		// Never label a blank separator row; keep the time on content.
		if (isBlankRow(rows[index]!)) continue;
		if (hasLabelRoom(rows[index]!, width, labelWidth)) return index;
	}
	return undefined;
}
