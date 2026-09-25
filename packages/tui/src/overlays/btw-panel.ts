import { type Component, Markdown, Text, type TUI } from "../index";
import { replaceTabs } from "../render/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { sanitizeErrorLine } from "../chrome/error-block";
import { OverlayPanel } from "../chrome/overlay-box";
import { StreamingPanelContent } from "../chrome/streaming-panel";

type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

/** Most recent lookup lines shown above a /btw answer. */
const MAX_LOOKUP_LINES = 6;

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
	canBranch?: () => boolean;
	canFollowUp?: () => boolean;
}

export class BtwPanelComponent extends OverlayPanel {
	#tui: TUI;
	#canBranch: (() => boolean) | undefined;
	#canFollowUp: (() => boolean) | undefined;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#visibleAnswer = "";
	#closed = false;
	#copied = false;
	/** The model stopped at its output-token limit, so the answer is incomplete. */
	#cutOff = false;
	#baseTitle: string;
	readonly #content: StreamingPanelContent;
	/** Lookups this answer ran (or was refused), shown dim above the answer; never part of copied text. */
	#lookups: string[] = [];

	constructor(options: BtwPanelComponentOptions) {
		const baseTitle = `/btw ${replaceTabs(options.question)}`;
		super(baseTitle);
		this.#baseTitle = baseTitle;
		this.#tui = options.tui;
		this.#canBranch = options.canBranch;
		this.#canFollowUp = options.canFollowUp;
		this.#content = new StreamingPanelContent(() => ({
			sections: [this.#lookupSection(), this.#contentComponent()],
			footer: () => this.#footerLine(),
		}));
		this.addChild(this.#content);
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#visibleAnswer = replaceTabs(this.#answer).trim();
		this.#setCopied(false);
		this.#rebuild();
	}

	/** Record one read-only lookup (`read src/app.ts`) or a refused call. */
	noteLookup(label: string, allowed: boolean): void {
		if (this.#closed) return;
		const line = replaceTabs(label);
		this.#lookups.push(allowed ? `· ${line}` : `${theme.status.warning} ${line} (not allowed)`);
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#visibleAnswer = replaceTabs(text).trim();
		this.#setCopied(false);
		this.#rebuild();
	}

	markComplete(options: { cutOff?: boolean } = {}): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#cutOff = options.cutOff === true;
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	/** Visual confirmation that `c` copied the answer to the clipboard. */
	markCopied(): void {
		if (this.#closed || !this.isCopyable()) return;
		this.#setCopied(true);
		this.#rebuild();
	}

	#setCopied(copied: boolean): void {
		this.#copied = copied;
		this.title = copied ? `${this.#baseTitle} ✓ Copied` : this.#baseTitle;
	}

	/** Shows that the completed answer is being promoted into the chat session. */
	markBranching(): void {
		if (this.#closed) return;
		this.#state = "branching";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#errorMessage = message;
		this.#setCopied(false);
		this.#rebuild();
	}
	isBranchable(): boolean {
		return this.isCopyable();
	}

	isCopyable(): boolean {
		return this.#state === "complete" && this.#visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		if (!this.isCopyable()) return undefined;
		// The answer as written: tabs are widened only for display, so copied
		// tab-indented code (Makefiles, Go) keeps its tabs.
		return this.#answer.trim();
	}

	close(): void {
		this.#closed = true;
	}

	#rebuild(): void {
		this.#content.refresh();
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#lookupSection(): Component | undefined {
		if (this.#lookups.length === 0) return undefined;
		const shown = this.#lookups.slice(-MAX_LOOKUP_LINES);
		const hidden = this.#lookups.length - shown.length;
		const lines = hidden > 0 ? [`… ${hidden} earlier`, ...shown] : shown;
		return new Text(theme.fg("dim", lines.join("\n")), 0, 0);
	}

	#footerLine(): string {
		switch (this.#state) {
			case "running":
				return theme.fg("muted", "Esc to cancel");
			case "complete": {
				const actions: string[] = [];
				if (this.isCopyable()) actions.push(this.#copied ? "c to copy again" : "c to copy");
				if (this.#canFollowUp?.()) actions.push("f to follow up");
				if (this.#canBranch?.() ?? this.isBranchable()) actions.push("b to branch");
				actions.push("Esc to close");
				const cutOff = this.#cutOff
					? `${theme.fg("warning", `${theme.status.warning} Cut off at the model's output limit`)}${theme.fg("muted", " · ")}`
					: "";
				if (this.#copied) {
					return `${cutOff}${theme.fg("success", "✓ Copied to clipboard")}${theme.fg("muted", actions.length > 0 ? ` · ${actions.join(" · ")}` : "")}`;
				}
				return `${cutOff}${theme.fg("muted", actions.join(" · "))}`;
			}
			case "branching":
				return theme.fg("muted", `${theme.status.pending} Branching to chat…`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · Esc to close`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · Esc to close`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", sanitizeErrorLine(this.#errorMessage ?? "Unknown error")), 0, 0);
		}
		const text = this.#visibleAnswer;
		if (!text) {
			const waiting =
				this.#state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
			return new Text(theme.fg("dim", waiting), 0, 0);
		}
		return new Markdown(text, 0, 0, getMarkdownTheme());
	}
}
