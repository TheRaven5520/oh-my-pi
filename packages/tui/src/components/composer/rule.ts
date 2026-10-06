/**
 * Single-rule composer: a borderless prompt docked below one top rule. The
 * right status group rides the rule while the left group remains below the
 * editor, preserving the compact status split without a closing rule.
 */
import { renderComposerTopLine } from "./top-line";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

/** Draw a full-width rule with status content docked at its right edge.
 * Over-wide content is truncated (keeping one rule cell on each side) rather
 * than dropped, so the chip survives narrow terminals and previews. */
export function renderTopRule(ctx: ComposerChromeContext): string {
	const { box, width, borderColor, topBorder } = ctx;
	if (width <= 2) return borderColor(box.horizontal.repeat(Math.max(0, width)));
	const edge = borderColor(box.horizontal);
	return (
		edge +
		renderComposerTopLine(topBorder, width - 2, cells => borderColor(box.horizontal.repeat(cells)), true) +
		edge
	);
}

/** Composer style with one status-bearing top rule and no bottom chrome. */
export const ruleComposerStyle: ComposerStyle = {
	id: "rule",
	titleSlot: true,
	sideBorders: false,
	verticalChrome: 1,
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	bottomBarGap: true,
	defaultPromptGutter: "❯ ",

	defaultPaddingX(): number {
		return 0;
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX;
	},

	renderTop(ctx: ComposerChromeContext): string {
		return renderTopRule(ctx);
	},

	renderRow(ctx: ComposerRowContext): string[] {
		return [ctx.gutter + ctx.text + ctx.pad];
	},

	renderBottom(): undefined {
		return undefined;
	},
};
