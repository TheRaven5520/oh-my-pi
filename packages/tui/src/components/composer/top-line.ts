import { padding, truncateToWidth, visibleWidth } from "../../utils";
import type { EditorTopBorder } from "./types";

/** Keep half the row (and at least 14 cells for an active-goal indicator) for status. */
export function composerTitleSlot(title: string | undefined, width: number): string {
	const budget = Math.min(60, Math.floor(width / 2) - 2, width - 17);
	if (!title || budget < 1) return "";
	return ` ${truncateToWidth(title, budget)} `;
}

/** Shared bounded top-line layout. Callers keep their edge glyphs outside this budget. */
export function renderComposerTopLine(
	topBorder: EditorTopBorder | undefined,
	width: number,
	fill: (cells: number) => string,
	alignStatusRight = false,
): string {
	const title = composerTitleSlot(topBorder?.title, width);
	const titleWidth = visibleWidth(title);
	const contentWidth = Math.max(0, width - titleWidth - (title ? 1 : 0));
	const content = truncateToWidth(topBorder?.content ?? "", contentWidth);
	const remaining = Math.max(0, width - visibleWidth(content) - titleWidth);
	if (alignStatusRight) {
		const gap = title && content ? 1 : 0;
		return fill(remaining - gap) + content + padding(gap) + title;
	}
	return content + fill(remaining) + title;
}
