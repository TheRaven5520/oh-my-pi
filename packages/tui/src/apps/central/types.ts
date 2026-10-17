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
	requests: CentralRequest[];
}

export interface CentralSnapshot {
	chats: CentralChat[];
	errors: string[];
}

/** Read-only presentation rendered by the selected chat at Central's available widths. */
export interface CentralWorkspace {
	statusLines: string[];
	usageLines: string[];
	canPrompt: boolean;
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
	answer(chatId: string, requestId: string, answer: CentralAnswer): Promise<void>;
	open(chatId: string): Promise<void>;
}
