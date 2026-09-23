import { padding, visibleWidth } from "../utils";
import { type Component, Container } from "../tui";
import { Disclosure } from "../components/disclosure";
import { Markdown } from "../components/markdown";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { ensureThemeSync, getMarkdownTheme, theme } from "../theme";
import {
	attachmentSgr,
	collapseImageMarkers,
	COMPOSER_TOKEN_REGEX,
	composerTokenRegex,
	modelChipStyle,
	modelMentionChipLabel,
	renderPlaceholders,
	skillChipStyle,
} from "../prompt/composer-attachments";
import { MODEL_MENTION_TAG_RE } from "../prompt/model-mention-syntax";
import { fileHyperlink } from "../render";
import { imageReferenceHyperlink } from "../prompt/image-references";
import { highlightMagicKeywords } from "../prompt/magic-keywords";
import type { ReactionTarget } from "./reaction";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers.
//
// The zone must be *closed* within the same render. `133;B` sets a sticky
// cursor semantic of `.input` in Ghostty (and Ghostty-derived terminals such
// as cmux) that only a command-start marker clears; leaving it latched makes
// `cursorIsAtPrompt()` permanently true and tags every subsequently painted
// cell as `.input`. Combined with `cursor-click-to-move = true` (Ghostty's
// default) that turns every left-click inside the pane into a burst of
// synthesized arrow keys on omp's pty, slamming the editor caret to column 0
// (#8030, #6115).
//
// `133;C` is therefore emitted immediately followed by `133;D;0` at the end of
// the bubble. That clears the input state without reintroducing the grouping
// problem the marker was originally omitted to avoid: the command zone opens
// and finishes inside this component, so later assistant/tool output can never
// be grouped under the first submitted prompt.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_COMMAND_START = "\x1b]133;C\x07";
const OSC133_COMMAND_DONE = "\x1b]133;D;0\x07";
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_COMMAND_START + OSC133_COMMAND_DONE;

/**
 * One-eighth-cell strips framing a user bubble, instead of full blank padding
 * rows: the lower strip sits flush on the bubble's first row and the upper strip
 * under its last row, so the tint reads as a thin margin. An optional badge is
 * right-aligned on the top edge. Terminal-default backgrounds draw blank edges.
 */
export function userBubbleEdge(width: number, edge: "top" | "bottom", badge?: string): string {
	const fg = theme.getBgAsFgAnsi("userMessageBg");
	const glyph = edge === "top" ? "▁" : "▔";
	const strip = (cells: number) => (cells <= 0 ? "" : fg ? `${fg}${glyph.repeat(cells)}\x1b[39m` : padding(cells));
	if (badge === undefined) return strip(width);
	return strip(width - 1 - visibleWidth(badge)) + badge + strip(1);
}

/** Frames a tinted child with {@link userBubbleEdge} rows; memoized on the child's render. */
export class UserBubbleFrame implements Component {
	#source: readonly string[] | undefined;
	#lines: string[] | undefined;

	constructor(readonly child: Component) {}

	invalidate(): void {
		this.child.invalidate?.();
		this.#source = undefined;
		this.#lines = undefined;
	}

	setIgnoreTight(ignore: boolean): this {
		this.child.setIgnoreTight?.(ignore);
		return this;
	}

	render(width: number): readonly string[] {
		const inner = this.child.render(width);
		if (this.#source === inner && this.#lines !== undefined) return this.#lines;
		const lines = [userBubbleEdge(width, "top"), ...inner, userBubbleEdge(width, "bottom")];
		this.#source = inner;
		this.#lines = lines;
		return lines;
	}
}

/** How a user bubble styles its prose and chips (see {@link userBubbleColor}). */
export interface UserBubbleOptions {
	/** Materialized `file://` targets per attached image, indexed by chip number. */
	imageLinks?: readonly (string | undefined)[];
	/** Agent-attributed input: dim, flat prose. */
	synthetic?: boolean;
	/** SKILL.md path for a skill chip by name; `undefined` leaves the chip unlinked. */
	skillPath?: (name: string) => string | undefined;
}

/**
 * Foreground styling for prose inside a user bubble: the bubble text color with the
 * magic-keyword glow, attachment chips in their composer identity color, and skill
 * chips as soft pills (linked to their SKILL.md) — each token restoring the bubble's
 * own foreground after it. Shared by {@link UserMessageComponent} and the skill
 * callout so both read as one turn.
 */
export function userBubbleColor(
	options: UserBubbleOptions = {},
	tokenRegex: RegExp = COMPOSER_TOKEN_REGEX,
): (value: string) => string {
	const { imageLinks, synthetic = false, skillPath } = options;
	// The Markdown component routes code spans and fenced blocks through its own code styling
	// (never `color`), so those are already excluded; `highlightMagicKeywords` additionally
	// restores the bubble's own foreground after each painted keyword so the gradient never
	// bleeds into the rest of the line.
	const keywordReset = theme.getFgOnBgAnsi("userMessageText", "userMessageBg");
	const bubbleReset = `${keywordReset}${theme.getBgAnsi("userMessageBg")}`;
	const renderText = synthetic
		? (text: string) => theme.fg("dim", text)
		: (text: string) => theme.fgOnBg("userMessageText", "userMessageBg", highlightMagicKeywords(text, keywordReset));
	return (value: string) =>
		renderPlaceholders(
			value,
			{
				renderText,
				renderSkill: (label, name) => {
					const styled = skillChipStyle(label, bubbleReset);
					const path = skillPath?.(name);
					return path ? fileHyperlink(path, styled, { line: 1 }) : styled;
				},
				renderMention: label => modelChipStyle(label, bubbleReset),
				renderReference: (label, kind, index, form) => {
					// Chip tokens keep their composer identity color; the bubble's own
					// foreground resumes after the token (same pattern as keywords).
					const styled =
						form === "chip"
							? `${attachmentSgr(kind, index)}\x1b[1m${label}\x1b[22m${keywordReset}`
							: theme.fg("accent", `\x1b[1m${label}\x1b[22m`);
					return kind === "image" || kind === "video"
						? imageReferenceHyperlink(label, index, imageLinks, () => styled)
						: styled;
				},
			},
			tokenRegex,
		);
}

/**
 * Component that renders a user message. Accepts an agent reaction badge
 * (see {@link ReactionTarget}) drawn right-aligned in the bubble's top padding row.
 */
export class UserMessageComponent extends Container implements ReactionTarget {
	// Memoized OSC 133 zone wrapping keyed on the underlying container render
	// (same source ref ⇒ identical rows ⇒ reuse the wrapped copy). Keeps this
	// component reference-stable for the transcript's incremental assembly and
	// never mutates the container's cached array.
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;
	#reaction: string | undefined;

	constructor(text: string, options: UserBubbleOptions = {}) {
		super();
		ensureThemeSync();
		// Display-only collapse: the stored/wire text carries bracketed `[Image #N, WxH]` markers,
		// but the transcript shows the same compact `<icon> #N` chip the composer used. Runs before
		// Markdown layout so wrapping and bubble padding are computed on the visible text.
		text = collapseImageMarkers(text, Number.POSITIVE_INFINITY, () => {});
		const mentionLabels: string[] = [];
		MODEL_MENTION_TAG_RE.lastIndex = 0;
		text = text.replace(MODEL_MENTION_TAG_RE, (_tag, _agent: string, name: string) => {
			const label = modelMentionChipLabel(name);
			mentionLabels.push(label);
			return label;
		});
		const md = new Markdown(text, 1, 0, getMarkdownTheme(), {
			bgColor: (value: string) => theme.bg("userMessageBg", value),
			color: userBubbleColor(options, composerTokenRegex(mentionLabels)),
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}

	setReaction(emoji: string): void {
		if (this.#reaction === emoji) return;
		this.#reaction = emoji;
		this.#zoneLines = undefined;
	}

	/** The top edge with the reaction badge right-aligned inside the horizontal padding. */
	#reactionRow(width: number): string {
		return userBubbleEdge(width, "top", this.#reaction);
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
		}
		const wrapped = [
			OSC133_ZONE_START + this.#reactionRow(width),
			...lines,
			userBubbleEdge(width, "bottom") + OSC133_ZONE_CLOSE,
		];
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}

/**
 * Always-visible dim summary row for a collapsed synthetic input. Kept as a
 * small domain renderer so the width-truncated label never pays Markdown
 * layout; the heavy body lives in the {@link Disclosure} detail slot.
 */
class SyntheticSummary implements Component {
	readonly #summary: string;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(summary: string) {
		this.#summary = summary;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const hint = `${theme.sep.dot.trim()} ctrl+o`;
		const lines = [` ${theme.fg("dim", truncateSummary(`${this.#summary} ${hint}`, Math.max(10, width - 1)))}`];
		this.#cache = { width, lines };
		return lines;
	}
}

/**
 * Collapsed placeholder for a synthetic (agent-attributed) user input in the
 * file/remote-backed transcript viewer — chiefly the advisor's `Session update`
 * replay dumps, which can each be hundreds of KiB of Markdown and, on cold open,
 * blocked the TUI for tens of seconds while every historical body was laid out
 * before the viewport clip (issue #6308).
 *
 * Collapsed by default: renders one dim summary row (label · size · line count ·
 * expand hint) and builds NO Markdown. The heavy {@link UserMessageComponent} is
 * constructed lazily only when expanded via `ctrl+o`, so blocks above the
 * viewport never pay layout cost until the reader asks to see them. The raw
 * observability data stays intact in `__advisor.jsonl`.
 */
export class CollapsedSyntheticMessageComponent implements Component {
	#disclosure: Disclosure;

	readonly #text: string;
	readonly #imageLinks?: readonly (string | undefined)[];

	constructor(text: string, imageLinks?: readonly (string | undefined)[]) {
		this.#text = text;
		this.#imageLinks = imageLinks;

		// The heavy UserMessageComponent is constructed lazily only on the
		// first expanded render and retained across collapse/re-expand cycles.
		this.#disclosure = new Disclosure({
			summary: new SyntheticSummary(summarizeSyntheticInput(text)),
			body: () => new UserMessageComponent(this.#text, { synthetic: true, imageLinks: this.#imageLinks }),
		});
	}

	/** ctrl+o toggle: reveal/hide the full Markdown body. */
	setExpanded(expanded: boolean): void {
		this.#disclosure.setExpanded(expanded);
	}

	setIgnoreTight(ignore: boolean): this {
		this.#disclosure.setIgnoreTight(ignore);
		return this;
	}

	invalidate(): void {
		this.#disclosure.invalidate();
	}

	dispose(): void {
		this.#disclosure.dispose();
	}

	render(width: number): readonly string[] {
		return this.#disclosure.render(width);
	}
}

/** Truncate a plain summary label to `maxWidth` display columns, appending `…`. */
function truncateSummary(text: string, maxWidth: number): string {
	if (Bun.stringWidth(text, { countAnsiEscapeCodes: false }) <= maxWidth) return text;
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = Bun.stringWidth(ch, { countAnsiEscapeCodes: false });
		if (w + cw > maxWidth - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/**
 * One-line summary for a collapsed synthetic input: `<label> · <size> · <n>
 * lines`. The label is the first Markdown heading's text (e.g. `Session
 * update`), falling back to `Synthetic input` when the body opens with none.
 */
function summarizeSyntheticInput(text: string): string {
	const size = formatBytes(Buffer.byteLength(text, "utf-8"));
	const lineCount = text === "" ? 0 : text.split("\n").length;
	const dot = theme.sep.dot.trim();
	return `${syntheticInputLabel(text)} ${dot} ${size} ${dot} ${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

/** First Markdown heading text in `text`, else `Synthetic input`. */
function syntheticInputLabel(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		return heading ? heading[1]!.trim() || "Synthetic input" : "Synthetic input";
	}
	return "Synthetic input";
}
