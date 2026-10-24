import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "../../overlays/ask-dialog";
import type { CollabUiSelectItem } from "@oh-my-pi/pi-wire";
import type { TranscriptEntryLike } from "../../chat/transcript-entry";
import type { EditorTopBorder } from "../../components/composer/types";

/** Full question data, independent of which terminal displays the answer form. */
export type CentralRequestDraft =
	| { kind: "ask"; questions: ExtensionAskDialogQuestion[] }
	| {
			kind: "select";
			title: string;
			options: CollabUiSelectItem[];
			initialIndex?: number;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: number[];
			markableCount?: number;
			disabledIndices?: number[];
	  }
	| { kind: "editor"; title: string; prefill?: string };

export type CentralRequest = CentralRequestDraft & { id: string; createdAt: number };
export type CentralAnswer = ExtensionAskDialogResult | string;

/** A live process; an unavailable source is never presented as an empty queue. */
export interface CentralChat {
	id: string;
	sessionId: string;
	pid: number;
	name: string;
	cwd: string;
	busy: boolean;
	source?: string;
	location?: { socket: string; pane: string };
	transcriptRevision?: string;
	/** IPC error code while a still-registered chat stands in with its last-known entry. */
	unresponsive?: string;
	requests: CentralRequest[];
}

export interface CentralSnapshot {
	chats: CentralChat[];
	errors: string[];
}

/** A slash command the selected chat runs, as listed by its own composer. */
export interface CentralCommandInfo {
	name: string;
	aliases?: string[];
	description?: string;
	argumentHint?: string;
}

/** Read-only presentation rendered by the selected chat at Central's available widths. */
export interface CentralWorkspace {
	statusLines: string[];
	usageLines: string[];
	canPrompt: boolean;
	/** The chat runs `/command` text through its own composer's submit path (Central `command` op). */
	canCommand?: boolean;
	/** The chat's own slash commands, for completion; capped by the chat. */
	commands?: CentralCommandInfo[];
	/** Source-session chrome, rendered with its own settings and account context. */
	composer?: { shape: string; topBorder: EditorTopBorder };
	promptUnavailableReason?: string;
}

/** The source proved this request was never admitted; the composer may issue a fresh request ID. */
export class CentralPromptRejectedError extends Error {
	readonly confirmedNoAdmission = true;
	constructor(message: string) {
		super(message);
		this.name = "CentralPromptRejectedError";
	}
}

export interface CentralTuiHost {
	/** Read on the inbox host, not the selected chat's (possibly remote) filesystem. Text excludes image markers. */
	readPromptPaste?(path?: string): Promise<{ text: string; images?: ImageContent[] }>;
	refresh(): Promise<CentralSnapshot>;
	transcript(chatId: string): Promise<TranscriptEntryLike[]>;
	workspace?(chatId: string, statusWidth: number, usageWidth: number): Promise<CentralWorkspace>;
	/** Submit to the existing session; reuse requestId when delivery is uncertain. */
	prompt?(chatId: string, sessionId: string, requestId: string, text: string): Promise<void>;
	/**
	 * Run `/command` text in the existing session as if typed in its composer; resolves
	 * with what the command showed. Same request-ID and stale-session rules as `prompt`.
	 */
	command?(chatId: string, sessionId: string, requestId: string, text: string): Promise<string>;
	answer(chatId: string, requestId: string, answer: CentralAnswer): Promise<void>;
	open(chatId: string): Promise<void>;
}

/** Local focus-composer commands, run on the Central host; never sent to the focused chat. */
export interface CentralFocusCommands {
	/** Ask the coordinator to relay `message` to `chat`; resolves with the tool's output. */
	relay(chat: string, message: string): Promise<string>;
	/** The last `count` coordinator inbox messages. */
	inbox(count: number): Promise<string>;
	/** Create or remove the coordinator's inbox-steer pause file; resolves with the resulting state. */
	setPaused(paused: boolean): Promise<string>;
	/** Task board URL; throws when it is not configured. */
	boardUrl(): string;
}

/** One chat, its assistant replies only, its open questions, and a prefixed composer. */
export interface CentralFocusOptions {
	/** Central chat name, sessionId or chatId; re-resolved on every poll. */
	target: string;
	/** Prepended to every composed message as part of its immutable payload; a convention, not authentication. */
	prefix: string;
	/** Put text on the user's clipboard (OSC 52 through the terminal, then native tools); used by drag-select and the copy key. */
	copyToClipboard(text: string): void | Promise<void>;
	commands: CentralFocusCommands;
}
