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

/** Claude Code's prompt pointer, drawn at the start of every user message. */
const USER_POINTER = "❯";
const USER_POINTER_WIDTH = 2;

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
 * Component that renders a user message the way Claude Code does: a dim `❯`
 * pointer, then the text on the tinted bubble with no padding rows. Accepts an
 * agent reaction badge (see {@link ReactionTarget}) drawn at the end of the first row.
 * While the request is in flight (sent, but not yet accepted by the server) the
 * text is dim, as Claude Code greys a prompt until the server receives it.
 */
export class UserMessageComponent extends Container implements ReactionTarget {
	readonly #md: Markdown;
	readonly #text: string;
	readonly #options: UserBubbleOptions;
	readonly #mentionLabels: string[];
	/** Dim rendering used only while awaiting the model; built on first use. */
	#awaitingMd: Markdown | undefined;
	#awaitingModel = false;
	// Memoized on the Markdown render (same source ref ⇒ identical rows) so this
	// component stays reference-stable for the transcript's incremental assembly.
	#source: readonly string[] | undefined;
	#lines: string[] | undefined;
	#reaction: string | undefined;

	constructor(text: string, options: UserBubbleOptions = {}) {
		super();
		ensureThemeSync();
		// Display-only collapse: the stored/wire text carries bracketed `[Image #N, WxH]` markers,
		// but the transcript shows the same compact `<icon> #N` chip the composer used. Runs before
		// Markdown layout so wrapping is computed on the visible text.
		text = collapseImageMarkers(text, Number.POSITIVE_INFINITY, () => {});
		const mentionLabels: string[] = [];
		MODEL_MENTION_TAG_RE.lastIndex = 0;
		text = text.replace(MODEL_MENTION_TAG_RE, (_tag, _agent: string, name: string) => {
			const label = modelMentionChipLabel(name);
			mentionLabels.push(label);
			return label;
		});
		this.#text = text;
		this.#options = options;
		this.#mentionLabels = mentionLabels;
		this.#md = this.#markdown(options);
		this.addChild(this.#md);
	}

	#markdown(options: UserBubbleOptions): Markdown {
		const md = new Markdown(this.#text, 0, 0, getMarkdownTheme(), {
			bgColor: (value: string) => theme.bg("userMessageBg", value),
			color: userBubbleColor(options, composerTokenRegex(this.#mentionLabels)),
		});
		md.setIgnoreTight(true);
		return md;
	}

	/** Dim the text until the server accepts the request carrying this prompt. */
	setAwaitingModel(awaiting: boolean): void {
		if (this.#awaitingModel === awaiting) return;
		this.#awaitingModel = awaiting;
		this.#lines = undefined;
	}

	get awaitingModel(): boolean {
		return this.#awaitingModel;
	}

	override invalidate(): void {
		super.invalidate();
		this.#awaitingMd?.invalidate();
		this.#lines = undefined;
	}

	setReaction(emoji: string): void {
		if (this.#reaction === emoji) return;
		this.#reaction = emoji;
		this.#lines = undefined;
	}

	override render(width: number): readonly string[] {
		const reaction = this.#reaction;
		// Right edge: one cell of bubble padding, or ` <badge> ` on the first row.
		const rightWidth = reaction === undefined ? 1 : visibleWidth(reaction) + 2;
		const md = this.#awaitingModel
			? (this.#awaitingMd ??= this.#markdown({ ...this.#options, synthetic: true }))
			: this.#md;
		const inner = md.render(Math.max(1, width - USER_POINTER_WIDTH - rightWidth));
		if (inner.length === 0) return inner;
		if (this.#source === inner && this.#lines !== undefined) return this.#lines;
		const bubble = (value: string) => theme.bg("userMessageBg", value);
		const pointer = bubble(`${theme.fg("dim", USER_POINTER)} `);
		const indent = bubble(padding(USER_POINTER_WIDTH));
		const rightPad = bubble(padding(rightWidth));
		const lines = inner.map((line, index) => {
			if (index > 0) return indent + line + rightPad;
			return pointer + line + (reaction === undefined ? rightPad : bubble(` ${reaction} `));
		});
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] += OSC133_ZONE_CLOSE;
		this.#source = inner;
		this.#lines = lines;
		return lines;
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
