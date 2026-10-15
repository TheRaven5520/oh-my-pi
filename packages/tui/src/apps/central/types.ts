import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "../../overlays/ask-dialog";
import type { CollabUiSelectItem } from "@oh-my-pi/pi-wire";
import type { TranscriptEntryLike } from "../../chat/transcript-entry";

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

export interface CentralTuiHost {
	refresh(): Promise<CentralSnapshot>;
	transcript(chatId: string): Promise<TranscriptEntryLike[]>;
	answer(chatId: string, requestId: string, answer: CentralAnswer): Promise<void>;
	open(chatId: string): Promise<void>;
}
