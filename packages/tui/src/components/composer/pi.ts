/**
 * Upstream-pi composer: full-width horizontal rules above and below plain
 * padded text — no side borders, no prompt gutter. The session title docks
 * on the upper rule; both status groups remain in the standalone bottom bar.
 */
import { padding } from "../../utils";
import { renderTopRule } from "./rule";
import type { ComposerChromeContext, ComposerRowContext, ComposerStyle } from "./types";

export const piComposerStyle: ComposerStyle = {
	id: "pi",
	titleSlot: true,
	sideBorders: false,
	verticalChrome: 2,
	statusAttachment: "none",
	bottomBar: "full",
	bottomBarGap: false,
	defaultPromptGutter: undefined,

	defaultPaddingX(): number {
		return 1;
	},

	sideChromeWidth(paddingX: number): number {
		return paddingX;
	},

	renderTop(ctx: ComposerChromeContext): string {
		return renderTopRule(ctx);
	},

	renderRow(ctx: ComposerRowContext): string[] {
		return [padding(this.sideChromeWidth(ctx.paddingX)) + ctx.gutter + ctx.text + ctx.pad];
	},

	renderBottom(ctx: ComposerChromeContext): string {
		return ctx.borderColor(ctx.box.horizontal.repeat(ctx.width));
	},
};
