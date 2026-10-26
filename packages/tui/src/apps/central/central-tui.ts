import { TUI, CURSOR_MARKER, type Component } from "../../tui";
import { ScrollView } from "../../components/scroll-view";
import { CustomEditor } from "../../prompt/custom-editor";
import { decodePrintableKey, matchesKey } from "../../keys";
import { getKeybindings } from "../../keybindings";
import { getDefaultPasteImageKeys } from "../../app-keybindings";
import { AskDialogComponent, type AskDialogPrompt, type AskDialogPromptValue } from "../../overlays/ask-dialog";
import {
	sanitizeDisplayLine,
	sanitizeDisplaySgrLine,
	sanitizeDisplayText,
} from "../../overlays/extensions/display-text";
import { HookEditorComponent } from "../../overlays/hook-editor";
import { HookSelectorComponent } from "../../overlays/hook-selector";
import { wrapTextWithAnsi } from "../../render/render-utils";
import { ChatTranscriptBuilder } from "../../chat/chat-transcript-builder";
import { routeSgrMouseInput, type SgrMouseEvent } from "../../mouse";
import { ProcessTerminal } from "../../terminal";
import { getEditorTheme, getThemeEpoch, theme } from "../../theme/theme";
import { isOsc66Line, truncateToWidth, visibleWidth } from "../../utils";
import {
	CentralFocusAutocompleteProvider,
	type CentralFocusCommand,
	type CentralFocusMemory,
	type CentralFocusNotice,
	type CentralFocusTurn,
	focusChatLines,
	focusHelpLines,
	focusTurns,
	mergeFocusNotices,
	parseFocusCommand,
	renderFocusTurns,
	resolveFocusTarget,
} from "./focus";
import { CentralQueue, type CentralQueueEntry } from "./queue";
import type {
	CentralAnswer,
	CentralChat,
	CentralFocusOptions,
	CentralSnapshot,
	CentralTuiHost,
	CentralWorkspace,
} from "./types";
import { CentralPromptRejectedError } from "./types";
import {
	highlightRow,
	orderedSelection,
	plainRow,
	rowSelection,
	type SelectionPoint,
	selectionText,
} from "./selection";

/** Focus mode keeps one draft for the target, whichever process currently serves it. */
const FOCUS_DRAFT_KEY = "\0focus";
/** How far before its send time a queued echo's transcript copy may be stamped (host clock skew). */
const FOCUS_QUEUED_SKEW_MS = 15_000;
/** Output lines a command's flow entry shows; the rest is counted as `… N more lines`. */
const FOCUS_NOTICE_LINES = 40;
/** Flow entries kept for the view's lifetime; the oldest go first. */
const FOCUS_NOTICE_LIMIT = 200;
/**
 * A kept draft no longer holds the idle restart once it has been viewed (F8) and
 * closed, or after this long unviewed; the restart then drops it.
 */
const FOCUS_KEPT_DRAFT_MS = 30 * 60_000;
/**
 * Focus: a question that arrived takes the keyboard by itself only after input
 * (any key or click) has been quiet this long, with the composer empty and no
 * card in use; see {@link CentralComponent#autoFocus}.
 */
const FOCUS_AUTO_IDLE_MS = 3000;
/**
 * After a question took the keyboard by itself, text, a paste, Enter or
 * Backspace typed this soon, before any other key reached the card, was meant
 * for the composer (typing began as it switched): it goes there, the keyboard
 * with it, and the question is marked new again.
 */
const FOCUS_AUTO_GRACE_MS = 1000;

interface CentralForm {
	component: Component;
	view: ScrollView;
	prompt?: {
		component: HookEditorComponent;
		resolve: (value: AskDialogPromptValue | undefined) => void;
		paste: () => Promise<boolean>;
	};
	answer?: CentralAnswer;
	sending: boolean;
	touched: boolean;
	details?: boolean;
	error?: string;
}

/** An answer was started on the card (moved, typed, sending or sent, or a sub-prompt open): it must not be swapped away. */
function formInUse(form: CentralForm | undefined): boolean {
	return form !== undefined && (form.touched || form.sending || form.answer !== undefined || !!form.prompt);
}

interface CentralDraft {
	input: CustomEditor;
	version: number;
	sending: boolean;
	error?: string;
	pending?: {
		chatId: string;
		sessionId: string;
		requestId: string;
		text: string;
		version: number;
		/** Sent with the `command` op; a retry must use the same op. */
		command?: boolean;
	};
}

/** A block of the focus frame whose text a drag can select. */
interface FocusSelectRegion {
	kind: "transcript" | "question";
	/** Logical rows; a scrolling region shows them from its view's offset. */
	lines: readonly string[];
	/** Frame row of the region's first row (negative when cut off above the frame). */
	top: number;
	height: number;
	view?: ScrollView;
}

/** Remote status rows may retain colors, but never terminal actions or extra rows. */
function workspaceLines(lines: readonly string[], width: number): string[] {
	return lines
		.slice(0, 64)
		.map(line => `${truncateToWidth(sanitizeDisplaySgrLine(line.slice(0, 16384)), width)}\x1b[0m`);
}

export interface CentralRestartOptions {
	/** True once a newer build is installed and ready to run. */
	restartReady(): boolean;
	/** How long input must be quiet before restarting; default one minute. */
	quietMs?: number;
	now?: () => number;
}

/** `restart`: closed by itself, idle, so a newer installed build can take over. */
export type CentralExit = "closed" | "restart";

/** One quiet inbox; all answer state stays attached to its original request. */
export class CentralComponent implements Component {
	readonly #queue = new CentralQueue<CentralForm>();
	readonly #emptyView = new ScrollView([], { height: 1 });
	readonly #finished = Promise.withResolvers<void>();
	#exit: CentralExit = "closed";
	#lastInputAt: number;
	#snapshot: CentralSnapshot = { chats: [], errors: [] };
	#timer: NodeJS.Timeout | undefined;
	#stopped = false;
	#opening = false;
	#openError: string | undefined;
	#retired: CentralQueueEntry<CentralForm> | undefined;
	#showRetired = false;
	/** When {@link #retired} was kept, and whether F8 has shown it since. */
	#retiredAt = 0;
	#retiredViewed = false;
	/** Focus: the question card shown, by queue key; {@link #syncFocusEntry} keeps it. */
	#focusEntryKey: string | undefined;
	/** Chosen with Tab/Shift+Tab: kept until it ends, even over the focused chat's own questions. */
	#focusEntryManual = false;
	/**
	 * Focus: open questions that have not had the keyboard yet, by queue key, in
	 * arrival order. Shown marked `new question`; {@link #autoFocus} moves the
	 * keyboard into the first whose chat responds once nothing typed can land in it.
	 */
	#focusNew: string[] = [];
	/** Keys of the open questions already seen, so each arrival counts as new once. */
	#focusSeen = new Set<string>();
	/** When a question last took the keyboard by itself, until the next key; see {@link FOCUS_AUTO_GRACE_MS}. */
	#autoFocusAt: number | undefined;
	/** Scroll the shown card's control into view at the next render (after an automatic switch). */
	#revealCard = false;
	focused = false;
	#selectedChatId: string | undefined;
	#manualSelection = false;
	#transcriptChatId: string | undefined;
	#transcriptRevision: string | undefined;
	#transcriptBuilder: ChatTranscriptBuilder | undefined;
	#transcriptLoadGeneration = 0;
	#transcriptLoadingChatId: string | undefined;
	#transcriptLoadingRevision: string | undefined;
	#transcriptError: string | undefined;
	#transcriptLoading = false;
	#questionTop = 0;
	#questionBudget = 12;
	#questionVisibleFor: CentralQueueEntry<CentralForm> | undefined;
	#transcriptView = new ScrollView([], { height: 1, followTail: true, scrollbar: "auto" });
	readonly #drafts = new Map<string, CentralDraft>();
	#inputFocus = false;
	#inputTop = Number.POSITIVE_INFINITY;
	#inputBottom = 0;
	#mainWidth = 0;
	#workspace: CentralWorkspace | undefined;
	#workspaceKey: string | undefined;
	#workspaceLoadingKey: string | undefined;
	#workspaceGeneration = 0;
	#statusWidth = 1;
	#usageWidth = 1;
	#workspaceError: string | undefined;
	#usageOffset = 0;
	#usageMaxOffset = 0;
	#focusMemory: CentralFocusMemory = {};
	/** Why the focused chat's view is stale; the last view and draft stay. */
	#focusNotice: string | undefined;
	/**
	 * Commands run and questions that ended elsewhere, oldest first, merged by time
	 * into the turns. Local to this view: a reload keeps them, a restart drops them.
	 */
	#focusNotices: CentralFocusNotice[] = [];
	#focusNoticeRevision = 0;
	#focusNoticeSeq = 0;
	/** The entry announcing {@link #retired}, whose recovery hint changes if a newer draft replaces it. */
	#retiredNotice: { notice: CentralFocusNotice; text: string } | undefined;
	/** Focus mode renders turns itself: dated replies and the user's own sent lines. */
	#focusTurns: CentralFocusTurn[] | undefined;
	/**
	 * Messages the chat accepted but has not yet put in its transcript, each with the
	 * time it was sent. The chat stamps its copy when it accepts it, so that copy is
	 * the first unclaimed sent turn with the same text stamped no earlier than
	 * {@link FOCUS_QUEUED_SKEW_MS} before `at` (the allowance covers clock skew
	 * between hosts). Timestamps, not entry ids: Central's transcript tail is capped
	 * and its ids are positions, so they shift as older entries drop off the front.
	 */
	#focusQueued: Array<{ text: string; at: number }> = [];
	/** `${timestamp}\0${text}` of sent turns a queued echo already claimed; each turn matches once. */
	#focusClaimed = new Set<string>();
	#focusRows: { key: string; rows: string[]; tailRows: number } | undefined;
	#focusCommandRunning = false;
	/** JSON of the command list the focus composer's completion was built from. */
	#focusCompletionKey: string | undefined;
	/** Rows the focus view can select from, as last drawn (frame rows). */
	#selectRegions: FocusSelectRegion[] = [];
	/** The left press that may become a click or a drag; `region` is where a drag would select. */
	#press: { row: number; col: number; region?: FocusSelectRegion["kind"]; point: SelectionPoint } | undefined;
	/** Drag selection in one region; `rows` holds the plain text of rows `first…` it was made on. */
	#selection:
		| {
				region: FocusSelectRegion["kind"];
				anchor: SelectionPoint;
				head: SelectionPoint;
				dragging: boolean;
				first: number;
				rows: string[];
		  }
		| undefined;
	#edgeScroll: { timer: NodeJS.Timeout; row: number; col: number } | undefined;
	#copyStatus: { text: string; error: boolean; until: number } | undefined;

	constructor(
		readonly ui: TUI,
		readonly host: CentralTuiHost,
		readonly restart?: CentralRestartOptions,
		readonly focus?: CentralFocusOptions,
	) {
		this.#lastInputAt = this.#now();
		// Focus is a typing surface: a question that appears mid-message must not
		// capture keystrokes meant for the composer. It takes the keyboard by itself
		// only when nothing typed can land in it ({@link #autoFocus}); F2, an arrow
		// on the empty composer, or a click select it sooner.
		this.#inputFocus = focus !== undefined;
	}

	#now(): number {
		return (this.restart?.now ?? Date.now)();
	}

	async run(): Promise<CentralExit> {
		void this.#refresh();
		await this.#finished.promise;
		return this.#exit;
	}

	/** Nothing typed, chosen or in flight would be lost, and the user is not mid-interaction. */
	#canRestart(): boolean {
		if (!this.restart || this.#opening) return false;
		if (this.#now() - this.#lastInputAt < (this.restart.quietMs ?? 60_000)) return false;
		if (this.#retired?.draft && this.#retiredHoldsRestart()) return false;
		for (const entry of this.#queue.entries) if (formInUse(entry.draft)) return false;
		for (const draft of this.#drafts.values()) {
			if (draft.sending || draft.pending) return false;
			if (draft.input.hasDraftContent()) return false;
		}
		return this.restart.restartReady();
	}

	async #refresh(): Promise<void> {
		try {
			const snapshot = await this.host.refresh();
			if (this.#stopped) return;
			this.#snapshot = snapshot;
			if (this.focus) this.#refreshFocus(snapshot);
			else {
				this.#retire(this.#queue.update(snapshot.chats));
				const selected =
					(this.#manualSelection
						? this.#snapshot.chats.find(chat => chat.id === this.#selectedChatId)
						: undefined) ??
					this.#snapshot.chats.find(chat => chat.id === this.#queue.current?.chat.id) ??
					this.#snapshot.chats[0];
				if (!selected) {
					this.#selectedChatId = undefined;
				} else {
					this.#selectedChatId = selected.id;
					if (selected.id !== this.#transcriptChatId || selected.transcriptRevision !== this.#transcriptRevision)
						void this.#loadTranscript(selected.id, selected.cwd, selected.transcriptRevision);
				}
			}
		} catch (error) {
			if (this.#stopped) return;
			this.#snapshot = {
				...this.#snapshot,
				errors: [`Cannot refresh chats: ${sanitizeDisplayLine(String(error))}. Retrying automatically.`],
			};
			if (this.focus)
				this.#focusNotice = `${this.#focusLabel()}: not responding; retrying (${sanitizeDisplayLine(String(error))})`;
		} finally {
			if (this.#stopped) {
				// Closed while this poll was in flight.
			} else if (this.#canRestart()) {
				this.#exit = "restart";
				this.#finished.resolve();
			} else {
				void this.#loadWorkspace(true);
				this.ui.requestRender();
				// Schedule after completion: slow sources never overlap another poll.
				this.#timer = setTimeout(() => void this.#refresh(), 1000);
			}
		}
	}

	/**
	 * Whether the kept draft still holds the idle restart. Focus: only until it has
	 * been viewed with F8 and closed, or {@link FOCUS_KEPT_DRAFT_MS} has passed; the
	 * question it answered is gone, so it is a stale copy and the restart drops it.
	 * Central keeps holding, as it has no way to view or discard a kept draft.
	 */
	#retiredHoldsRestart(): boolean {
		if (!this.focus) return true;
		if (this.#now() - this.#retiredAt >= FOCUS_KEPT_DRAFT_MS) return false;
		return this.#showRetired || !this.#retiredViewed;
	}

	#retire(entries: CentralQueueEntry<CentralForm>[]): void {
		for (const entry of entries) {
			const kept = entry.draft?.touched === true && entry.draft.answer === undefined;
			if (kept) {
				if (this.#retired?.draft) this.#disposeForm(this.#retired.draft);
				this.#retired = entry;
				this.#showRetired = false;
				this.#retiredAt = this.#now();
				this.#retiredViewed = false;
			} else if (entry.draft) this.#disposeForm(entry.draft);
			if (this.focus) this.#noteRetired(entry, kept);
		}
	}

	/** A chat's name, with its host when that is not this machine. */
	#chatLabel(chat: CentralChat): string {
		const name = sanitizeDisplayLine(chat.name) || "Untitled chat";
		return chat.source && chat.source !== "local" ? `${name} (${sanitizeDisplayLine(chat.source)})` : name;
	}

	/** A question that ended elsewhere, as a flow entry naming its chat; a kept draft says how to view it. */
	#noteRetired(entry: CentralQueueEntry<CentralForm>, kept: boolean): void {
		const request = entry.request;
		const asked = request.kind === "ask" ? (request.questions[0]?.question ?? "") : request.title;
		const first = sanitizeDisplayLine(asked.split("\n").find(line => line.trim()) ?? "").trim();
		const text = `${this.#chatLabel(entry.chat)} question "${truncateToWidth(first, 60)}" ended elsewhere`;
		if (kept && this.#retiredNotice) {
			this.#retiredNotice.notice.title = `${this.#retiredNotice.text} · draft replaced by a newer one`;
		}
		const notice = this.#addFocusNotice(kept ? `${text} · draft kept: F8 to view` : text, []);
		if (kept) this.#retiredNotice = { notice, text };
	}

	/** F9 in the F8 view: the kept draft is gone for good, and its flow entry says so. */
	#discardRetired(): void {
		if (this.#retired?.draft) this.#disposeForm(this.#retired.draft);
		this.#retired = undefined;
		this.#showRetired = false;
		if (this.#retiredNotice) {
			this.#retiredNotice.notice.title = `${this.#retiredNotice.text} · draft discarded`;
			this.#retiredNotice = undefined;
			this.#focusNoticeRevision++;
		}
	}

	/** Kept oldest first by time, for {@link mergeFocusNotices}; `at` defaults to now. */
	#addFocusNotice(title: string, lines: readonly string[], more = 0, at = Date.now()): CentralFocusNotice {
		// Date.now(), like the chat's own stamps; each host's clock, so skew between hosts can reorder close calls.
		const notice: CentralFocusNotice = {
			kind: "notice",
			id: `notice-${++this.#focusNoticeSeq}`,
			at,
			title,
			lines,
			more,
		};
		let index = this.#focusNotices.length;
		while (index > 0 && this.#focusNotices[index - 1]!.at > at) index--;
		this.#focusNotices.splice(index, 0, notice);
		if (this.#focusNotices.length > FOCUS_NOTICE_LIMIT) this.#focusNotices.shift();
		this.#focusNoticeRevision++;
		return notice;
	}

	#focusLabel(): string {
		return sanitizeDisplayLine(this.#focusMemory.name ?? this.focus?.target ?? "") || "Untitled chat";
	}

	/**
	 * Rendered turns and notices, rebuilt only when the turns, notices, queued
	 * sends, width, busy state or theme change; Markdown for a long chat is too
	 * costly per frame. `tailRows` is the height of a notice that is the newest
	 * entry (with the `…working` line), else 0.
	 */
	#renderFocusRows(width: number, busy: boolean): { rows: string[]; tailRows: number } {
		const key = `${width}|${busy}|${getThemeEpoch()}|${this.#focusQueued.length}|${this.#focusNoticeRevision}`;
		if (this.#focusRows?.key === key) return this.#focusRows;
		const queued: CentralFocusTurn[] = this.#focusQueued.map((entry, index) => ({
			kind: "sent",
			id: `queued-${index}`,
			at: entry.at,
			text: entry.text,
			queued: true,
		}));
		const turns = mergeFocusNotices([...(this.#focusTurns ?? []), ...queued], this.#focusNotices);
		const rows = renderFocusTurns(turns, width, busy && this.#focusTurns !== undefined);
		// Before the first load, notices (command output) still show, under the loading line.
		if (!this.#focusTurns) rows.unshift(theme.fg("muted", "Loading chat transcript…"));
		const last = turns.at(-1);
		const tailRows = last?.kind === "notice" ? renderFocusTurns([last], width, busy).length + 1 : 0;
		this.#focusRows = { key, rows, tailRows };
		return this.#focusRows;
	}

	/**
	 * Follow the target across restarts: its session, then its name. Until it
	 * answers again, the last view, questions and draft stay where they are.
	 */
	#refreshFocus(snapshot: CentralSnapshot): void {
		// Every listed chat's questions, on every host; each is answered in its own chat.
		this.#retire(this.#queue.update(snapshot.chats));
		this.#resolveFocus(snapshot);
		this.#trackNewQuestions();
		this.#syncFocusEntry();
		this.#autoFocus();
	}

	/**
	 * Every open question not seen before is new, in focus order (two arriving in
	 * one poll: the focused chat's first). A question stops being new once the
	 * keyboard has been in its card or an answer to it was started.
	 */
	#trackNewQuestions(): void {
		const entries = this.#focusEntries();
		const open = new Set(entries.map(entry => entry.key));
		for (const key of this.#focusSeen) if (!open.has(key)) this.#focusSeen.delete(key);
		this.#focusNew = this.#focusNew.filter(key => open.has(key));
		for (const entry of entries) {
			if (this.#focusSeen.has(entry.key)) continue;
			this.#focusSeen.add(entry.key);
			this.#focusNew.push(entry.key);
		}
		const started = new Set(entries.filter(entry => formInUse(entry.draft)).map(entry => entry.key));
		if (!this.#inputFocus && this.#focusEntryKey !== undefined) started.add(this.#focusEntryKey);
		this.#focusNew = this.#focusNew.filter(key => !started.has(key));
	}

	/**
	 * Move the keyboard into the first new question whose chat responds, scrolled
	 * into view, once nothing typed can land in it: the keyboard is in the composer,
	 * the composer is empty (no completion popup), no key or click for
	 * {@link FOCUS_AUTO_IDLE_MS}, no drag under way, and the shown card has no
	 * answer started. It replaces the shown card (an untouched one stays in the
	 * queue for `Tab`) and closes the F8 view. A card in use is never replaced;
	 * until then the new question stays marked and this runs again each poll.
	 * Keys right after the switch are guarded in {@link handleInput}.
	 */
	#autoFocus(): void {
		if (!this.focus || !this.#inputFocus || this.#press || this.#selection) return;
		if (this.#now() - this.#lastInputAt < FOCUS_AUTO_IDLE_MS) return;
		const composer = this.#drafts.get(FOCUS_DRAFT_KEY)?.input;
		if (composer?.hasDraftContent() || composer?.isShowingAutocomplete()) return;
		const entries = this.#focusEntries();
		if (formInUse(entries.find(entry => entry.key === this.#focusEntryKey)?.draft)) return;
		const next = entries.find(entry => this.#focusNew.includes(entry.key) && !this.#focusUnresponsive(entry.chat));
		if (!next) return;
		this.#focusNew = this.#focusNew.filter(key => key !== next.key);
		this.#focusEntryKey = next.key;
		this.#focusEntryManual = true;
		this.#showRetired = false;
		this.#inputFocus = false;
		this.#autoFocusAt = this.#now();
		this.#revealCard = true;
	}

	#resolveFocus(snapshot: CentralSnapshot): void {
		const resolution = resolveFocusTarget(snapshot.chats, this.focus!.target, this.#focusMemory);
		if (resolution.kind === "ambiguous") {
			this.#focusNotice = resolution.message;
			return;
		}
		if (resolution.kind === "missing") {
			// No process serves the target, so its questions are gone with it.
			this.#focusNotice =
				this.#focusMemory.sessionId === undefined
					? resolution.message
					: `${this.#focusLabel()}: not responding; retrying (not listed by any host)`;
			return;
		}
		const chat = resolution.chat;
		this.#focusMemory = { sessionId: chat.sessionId, name: chat.name };
		const sourceError = snapshot.errors.find(error => error.startsWith(`${chat.source ?? "local"}: `));
		this.#focusNotice = chat.unresponsive
			? `${this.#focusLabel()}: not responding (${chat.unresponsive}); retrying`
			: sourceError
				? `${this.#focusLabel()}: not responding; retrying (${sanitizeDisplayLine(sourceError)})`
				: undefined;
		this.#selectedChatId = chat.id;
		if (
			chat.id !== this.#transcriptChatId ||
			chat.transcriptRevision !== this.#transcriptRevision ||
			(this.#transcriptError !== undefined && !chat.unresponsive)
		)
			void this.#loadTranscript(chat.id, chat.cwd, chat.transcriptRevision);
	}

	/** Focus: every open question, the focused chat's first, then the others oldest first. */
	#focusEntries(): CentralQueueEntry<CentralForm>[] {
		const own = this.#selectedChatId;
		return [...this.#queue.entries].sort(
			(a, b) =>
				Number(b.chat.id === own) - Number(a.chat.id === own) ||
				a.request.createdAt - b.request.createdAt ||
				a.key.localeCompare(b.key),
		);
	}

	#focusEntry(): CentralQueueEntry<CentralForm> | undefined {
		const entries = this.#focusEntries();
		return entries.find(entry => entry.key === this.#focusEntryKey) ?? entries[0];
	}

	/**
	 * After a poll: the card stays while it is in use (keyboard in it, an answer
	 * started, or chosen with Tab), so a poll never swaps the question under a key;
	 * otherwise the first new question shows (marked; one whose chat responds
	 * first), else the first in order. When the shown card's question ends, keys go
	 * back to the composer, never to the card that replaces it.
	 */
	#syncFocusEntry(): void {
		const entries = this.#focusEntries();
		const fresh = entries.filter(entry => this.#focusNew.includes(entry.key));
		const preferred = (fresh.find(entry => !this.#focusUnresponsive(entry.chat)) ?? fresh[0] ?? entries[0])?.key;
		const current = entries.find(entry => entry.key === this.#focusEntryKey);
		if (!current) {
			if (this.#focusEntryKey !== undefined) this.#inputFocus = true;
			this.#focusEntryManual = false;
			this.#focusEntryKey = preferred;
			return;
		}
		const inUse = this.#focusEntryManual || !this.#inputFocus || formInUse(current.draft);
		if (!inUse) this.#focusEntryKey = preferred;
	}

	/** Tab/Shift+Tab in a focused question card: the next or previous open question, keyboard staying in the card. */
	#cycleFocusEntry(direction: -1 | 1): void {
		const entries = this.#focusEntries();
		if (entries.length < 2) return;
		const index = Math.max(0, entries.indexOf(this.#focusEntry()!));
		this.#focusEntryKey = entries[(index + direction + entries.length) % entries.length]!.key;
		this.#focusEntryManual = true;
	}

	/** Why a question's chat cannot take an answer now (its last-known question still shows). */
	#focusUnresponsive(chat: CentralChat): string | undefined {
		if (chat.unresponsive) return chat.unresponsive;
		const prefix = `${chat.source ?? "local"}: `;
		return this.#snapshot.errors.some(error => error.startsWith(prefix)) ? "host not reachable" : undefined;
	}

	#entryForSelectedChat(): CentralQueueEntry<CentralForm> | undefined {
		if (this.focus) return this.#focusEntry();
		return this.#selectedChatId ? this.#queue.entryForChat(this.#selectedChatId) : this.#queue.current;
	}

	#followQueueCurrent(): void {
		if (this.focus) {
			// The view is pinned to the focused chat; typing goes back to the composer.
			this.#inputFocus = true;
			this.ui.requestRender();
			return;
		}
		this.#manualSelection = false;
		const next = this.#queue.current;
		const selected = next?.chat ?? this.#snapshot.chats[0];
		this.#selectedChatId = selected?.id;
		void this.#loadWorkspace();
		if (selected) void this.#loadTranscript(selected.id, selected.cwd, selected.transcriptRevision);
		this.ui.requestRender();
	}
	#skipChat(chatId: string): void {
		if (this.focus) {
			// One chat: leaving its question returns to the composer, never cancels it.
			this.#inputFocus = true;
			this.ui.requestRender();
			return;
		}
		this.#queue.skip(chatId);
		this.#followQueueCurrent();
	}

	#selectChat(chatId: string, manual: boolean): void {
		const chat = this.#snapshot.chats.find(candidate => candidate.id === chatId);
		if (!chat) return;
		this.#manualSelection = manual;
		this.#selectedChatId = chatId;
		void this.#loadWorkspace();
		void this.#loadTranscript(chat.id, chat.cwd, chat.transcriptRevision);
		this.ui.requestRender();
	}

	async #loadTranscript(chatId: string, cwd: string, revision?: string): Promise<void> {
		const sameInFlight =
			this.#transcriptLoading &&
			this.#transcriptLoadingChatId === chatId &&
			this.#transcriptLoadingRevision === revision;
		if (sameInFlight) return;
		const generation = ++this.#transcriptLoadGeneration;
		const switchingChat = chatId !== this.#transcriptChatId;
		this.#transcriptLoading = true;
		this.#transcriptLoadingChatId = chatId;
		this.#transcriptLoadingRevision = revision;
		this.#transcriptError = undefined;
		// Focus keeps the last view of a restarting target until its new process answers.
		if (switchingChat && !this.focus) {
			this.#transcriptBuilder?.dispose();
			this.#transcriptBuilder = undefined;
			this.#transcriptChatId = undefined;
			this.#transcriptRevision = undefined;
			this.#transcriptView.setLines([]);
			this.#transcriptView.setFollowTail(true);
			this.#transcriptView.scrollToBottom();
		}
		this.ui.requestRender();
		try {
			const entries = await this.host.transcript(chatId);
			if (this.#stopped || generation !== this.#transcriptLoadGeneration || this.#selectedChatId !== chatId) return;
			if (this.focus) {
				const turns = focusTurns(entries, this.focus.prefix);
				this.#focusTurns = turns;
				const sent = turns.flatMap(turn =>
					turn.kind === "sent" && turn.at !== undefined
						? [{ key: `${turn.at}\0${turn.text}`, at: turn.at, text: turn.text }]
						: [],
				);
				// A claim outlives reloads; it is forgotten only once its turn left the tail.
				const present = new Set(sent.map(turn => turn.key));
				for (const key of this.#focusClaimed) if (!present.has(key)) this.#focusClaimed.delete(key);
				this.#focusQueued = this.#focusQueued.filter(queued => {
					const own = sent.find(
						turn =>
							turn.text === queued.text &&
							turn.at >= queued.at - FOCUS_QUEUED_SKEW_MS &&
							!this.#focusClaimed.has(turn.key),
					);
					if (own) this.#focusClaimed.add(own.key);
					return !own;
				});
				this.#focusRows = undefined;
			} else {
				const builder = new ChatTranscriptBuilder({
					ui: this.ui,
					cwd,
					requestRender: () => this.ui.requestRender(),
				});
				builder.rebuild(entries);
				this.#transcriptBuilder?.dispose();
				this.#transcriptBuilder = builder;
			}
			this.#transcriptChatId = chatId;
			this.#transcriptRevision = revision;
		} catch (error) {
			if (this.#stopped || generation !== this.#transcriptLoadGeneration || this.#selectedChatId !== chatId) return;
			this.#transcriptError = `Cannot load chat transcript: ${sanitizeDisplayLine(String(error))}. Retrying automatically.`;
		} finally {
			if (generation === this.#transcriptLoadGeneration) {
				this.#transcriptLoading = false;
				this.#transcriptLoadingChatId = undefined;
				this.#transcriptLoadingRevision = undefined;
				if (!this.#stopped) this.ui.requestRender();
			}
		}
	}

	async #loadWorkspace(refresh = false): Promise<void> {
		const chat = this.#snapshot.chats.find(candidate => candidate.id === this.#selectedChatId);
		const key = chat ? JSON.stringify([chat.id, chat.sessionId, this.#statusWidth, this.#usageWidth]) : undefined;
		if (key === this.#workspaceKey && (!refresh || key === this.#workspaceLoadingKey)) return;
		const generation = ++this.#workspaceGeneration;
		if (key !== this.#workspaceKey) {
			this.#workspace = undefined;
			this.#usageOffset = 0;
		}
		this.#workspaceKey = key;
		this.#workspaceError = undefined;
		if (!chat || !this.host.workspace) return;
		this.#workspaceLoadingKey = key;
		try {
			const workspace = await this.host.workspace(chat.id, this.#statusWidth, this.#usageWidth);
			if (this.#stopped || generation !== this.#workspaceGeneration || chat.id !== this.#selectedChatId) return;
			this.#workspace = workspace;
		} catch (error) {
			if (this.#stopped || generation !== this.#workspaceGeneration || chat.id !== this.#selectedChatId) return;
			this.#workspace = undefined;
			this.#workspaceError = `Status unavailable: ${sanitizeDisplayLine(String(error))}`;
		} finally {
			if (generation === this.#workspaceGeneration) {
				this.#workspaceLoadingKey = undefined;
				if (!this.#stopped) {
					this.#syncFocusCompletion();
					this.ui.requestRender();
				}
			}
		}
	}

	#draft(chatId: string): CentralDraft {
		let draft = this.#drafts.get(chatId);
		if (!draft) {
			const input = new CustomEditor(getEditorTheme());
			input.setBorderStyle("band");
			input.setShimmerRepaintHandler(() => this.ui.requestRender());
			input.disableSubmit = true;
			input.setScrollbarVisible(true);
			draft = { input, version: 0, sending: false };
			this.#drafts.set(chatId, draft);
			if (this.focus) {
				// The popup appears asynchronously; repaint when it opens or narrows.
				input.onAutocompleteUpdate = () => this.ui.requestRender();
				this.#focusCompletionKey = undefined;
				this.#syncFocusCompletion();
			}
		}
		return draft;
	}

	/** Focus composer completion: local commands plus the focused chat's list, rebuilt when that list changes. */
	#syncFocusCompletion(): void {
		const draft = this.focus ? this.#drafts.get(FOCUS_DRAFT_KEY) : undefined;
		if (!draft) return;
		const remote = this.#workspace?.canCommand && this.host.command ? (this.#workspace.commands ?? []) : [];
		const key = JSON.stringify(remote);
		if (key === this.#focusCompletionKey) return;
		this.#focusCompletionKey = key;
		draft.input.setAutocompleteProvider(new CentralFocusAutocompleteProvider(remote));
	}

	#promptUnavailable(): string | undefined {
		if (!this.host.prompt) return "This Central host cannot send. Update OMP; use Ctrl+O to open the chat.";
		if (!this.#workspace)
			return this.#workspaceError
				? "Ctrl+O: resume chat with current OMP. Sending unavailable; draft kept."
				: "Loading chat capabilities; wait and retry. Draft kept here.";
		if (!this.#workspace.canPrompt)
			return (
				this.#workspace.promptUnavailableReason ??
				"Ctrl+O: resume chat with current OMP. Sending unavailable; draft kept."
			);
		return undefined;
	}

	async #sendPrompt(chat: CentralChat, draft: CentralDraft, retry = false): Promise<void> {
		if (draft.sending) return;
		if (draft.pending && !retry) {
			draft.error = "Delivery unconfirmed · Ctrl+R retries the saved message; your edited draft is kept.";
			return;
		}
		const unavailable = this.#promptUnavailable();
		if (unavailable) {
			draft.error = unavailable;
			this.ui.requestRender();
			return;
		}
		if (!draft.pending) {
			const typed = draft.input.getExpandedText();
			if (!typed.trim()) return;
			// The prefix is part of the immutable payload, so a retry resends identical text.
			const text = this.focus ? `${this.focus.prefix}${typed}` : typed;
			if (new TextEncoder().encode(text).byteLength > 65536) {
				draft.error = "Message exceeds 64 KiB; shorten it before sending.";
				return;
			}
			draft.pending = {
				chatId: chat.id,
				sessionId: chat.sessionId,
				requestId: crypto.randomUUID(),
				text,
				version: draft.version,
			};
		}
		const pending = draft.pending;
		draft.sending = true;
		draft.error = undefined;
		this.ui.requestRender();
		try {
			// The chat stamps its copy when it accepts it, at or after this moment.
			const sentAt = Date.now();
			await this.host.prompt!(pending.chatId, pending.sessionId, pending.requestId, pending.text);
			if (draft.version === pending.version) draft.input.setText("");
			draft.pending = undefined;
			// A steer to a busy chat enters its transcript only when the chat takes
			// it; show it at once, marked queued, until the transcript has it.
			if (this.focus) this.#focusQueued.push({ text: pending.text.slice(this.focus.prefix.length), at: sentAt });
		} catch (error) {
			if (error instanceof CentralPromptRejectedError) {
				draft.pending = undefined;
				draft.error = `Not sent · edit or Enter to send again · ${sanitizeDisplayLine(error.message)}`;
			} else {
				draft.error = `Delivery unconfirmed · Ctrl+R retry saved message · ${sanitizeDisplayLine(String(error))}`;
			}
		} finally {
			draft.sending = false;
			if (!this.#stopped) this.ui.requestRender();
		}
	}

	/**
	 * A `/command` for the focused chat: run there through its own composer, never
	 * sent as a prefixed prompt. Same request-ID retry rules as a message.
	 */
	async #sendCommand(chat: CentralChat, draft: CentralDraft, retry = false): Promise<void> {
		if (draft.sending) return;
		if (draft.pending && !retry) {
			draft.error = "Delivery unconfirmed · Ctrl+R retries the saved message; your edited draft is kept.";
			return;
		}
		const unavailable = this.#promptUnavailable();
		if (unavailable) {
			draft.error = unavailable;
			return;
		}
		if (!this.host.command || !this.#workspace?.canCommand) {
			draft.error = "This chat cannot run /commands from Central; update OMP on the chat's host. Nothing was sent.";
			return;
		}
		if (!draft.pending) {
			const text = draft.input.getExpandedText().trim();
			if (new TextEncoder().encode(text).byteLength > 65536) {
				draft.error = "Command exceeds 64 KiB; shorten it before sending.";
				return;
			}
			draft.pending = {
				chatId: chat.id,
				sessionId: chat.sessionId,
				requestId: crypto.randomUUID(),
				text,
				version: draft.version,
				command: true,
			};
		}
		const pending = draft.pending;
		draft.sending = true;
		draft.error = undefined;
		this.ui.requestRender();
		try {
			// Stamped when it started, so anything the chat writes for it lands below it.
			const ranAt = Date.now();
			const result = await this.host.command(pending.chatId, pending.sessionId, pending.requestId, pending.text);
			if (draft.version === pending.version) draft.input.setText("");
			draft.pending = undefined;
			this.#showFocusOutput(pending.text.split(/\s/, 1)[0]!, result, ranAt, true);
			void this.#loadWorkspace(true);
		} catch (error) {
			if (error instanceof CentralPromptRejectedError) {
				draft.pending = undefined;
				draft.error = `Not run · edit or Enter to send again · ${sanitizeDisplayLine(error.message)}`;
			} else {
				draft.error = `Result unknown · Ctrl+R retries the saved command · ${sanitizeDisplayLine(String(error))}`;
			}
		} finally {
			draft.sending = false;
			if (!this.#stopped) this.ui.requestRender();
		}
	}

	/**
	 * A command's output as a dated flow entry at `at`. It was the user's own
	 * action, so the view jumps to the bottom even if he had scrolled up.
	 */
	#showFocusOutput(title: string, text: string | string[], at: number, remote = false): void {
		const all = typeof text === "string" ? text.replace(/\s+$/, "").split("\n") : text;
		const lines = all.some(Boolean) ? all : ["(no output)"];
		this.#addFocusNotice(
			`${title} · ${remote ? "ran in the chat" : "local, not sent"}`,
			lines.slice(0, FOCUS_NOTICE_LINES),
			Math.max(0, lines.length - FOCUS_NOTICE_LINES),
			at,
		);
		this.#transcriptView.setFollowTail(true);
		this.#transcriptView.scrollToBottom();
	}

	/** Local Central commands; they never reach the focused chat. */
	async #runFocusCommand(
		command: Exclude<CentralFocusCommand, { name: "remote" }>,
		draft: CentralDraft,
	): Promise<void> {
		if (command.name === "error") {
			draft.error = command.message;
			return;
		}
		if (this.#focusCommandRunning) {
			draft.error = "A local command is still running; wait for it to finish.";
			return;
		}
		const commands = this.focus!.commands;
		const version = draft.version;
		const ranAt = Date.now();
		this.#focusCommandRunning = true;
		draft.error = undefined;
		this.ui.requestRender();
		try {
			switch (command.name) {
				case "help":
					this.#showFocusOutput(
						"/help",
						focusHelpLines(this.#workspace?.commands, !!(this.#workspace?.canCommand && this.host.command)),
						ranAt,
					);
					break;
				case "chats":
					this.#showFocusOutput("/chats", focusChatLines(this.#snapshot, this.#selectedChatId), ranAt);
					break;
				case "dag":
					this.#showFocusOutput("/dag", commands.boardUrl(), ranAt);
					break;
				case "inbox":
					this.#showFocusOutput(`/inbox ${command.count}`, await commands.inbox(command.count), ranAt);
					break;
				case "pause":
				case "resume":
					this.#showFocusOutput(`/${command.name}`, await commands.setPaused(command.name === "pause"), ranAt);
					break;
				case "send":
					this.#showFocusOutput(
						`/send ${command.chat}`,
						await commands.relay(command.chat, command.message),
						ranAt,
					);
					break;
			}
			if (draft.version === version) draft.input.setText("");
		} catch (error) {
			draft.error = `${sanitizeDisplayLine(error instanceof Error ? error.message : String(error))} · nothing was sent to the focused chat`;
		} finally {
			this.#focusCommandRunning = false;
			if (!this.#stopped) this.ui.requestRender();
		}
	}

	#form(entry: CentralQueueEntry<CentralForm>): CentralForm {
		if (entry.draft) return entry.draft;
		const request = entry.request;
		const submit = (answer: CentralAnswer): void => {
			if (!this.#queue.has(entry) || this.#stopped) return;
			const form = entry.draft!;
			if (form.sending || form.answer !== undefined) return;
			form.answer = answer;
			void this.#send(entry);
		};
		let component: Component;
		if (request.kind === "ask") {
			component = new AskDialogComponent(
				request.questions,
				{
					onSubmit: submit,
					onCancel: () => this.#skipChat(entry.chat.id),
					onPrompt: async (prompt, prefill) =>
						(await this.#prompt(entry, prompt, prefill === undefined ? undefined : { text: prefill }))?.text,
					onImagePrompt: (prompt, prefill) => this.#prompt(entry, prompt, prefill),
				},
				{ tui: this.ui, showTabHint: false, showExpandHint: false, availableRows: () => this.#questionBudget },
			);
		} else if (request.kind === "select") {
			component = new HookSelectorComponent(
				request.title,
				request.options,
				submit,
				() => this.#skipChat(entry.chat.id),
				{
					tui: this.ui,
					initialIndex: request.initialIndex,
					selectionMarker: request.selectionMarker,
					checkedIndices: request.checkedIndices,
					markableCount: request.markableCount,
					disabledIndices: request.disabledIndices,
					maxVisible: Math.max(3, this.ui.terminal.rows - 14),
					markSelectedRow: true,
				},
			);
		} else {
			component = new HookEditorComponent(
				this.ui,
				request.title,
				request.prefill,
				submit,
				() => this.#skipChat(entry.chat.id),
				{ maxHeight: Math.max(3, this.ui.terminal.rows - 16) },
			);
		}
		const form: CentralForm = {
			component,
			view: new ScrollView([], { height: 1 }),
			sending: false,
			touched: false,
		};
		entry.draft = form;
		return form;
	}

	#prompt(
		entry: CentralQueueEntry<CentralForm>,
		prompt: AskDialogPrompt,
		prefill?: AskDialogPromptValue,
	): Promise<AskDialogPromptValue | undefined> {
		if (this.#stopped || !this.#queue.has(entry)) return Promise.resolve(undefined);
		const form = entry.draft!;
		const { promise, resolve } = Promise.withResolvers<AskDialogPromptValue | undefined>();
		const finish = (value: AskDialogPromptValue | undefined): void => {
			form.prompt?.component.dispose();
			form.prompt = undefined;
			form.view.setScrollOffset(0);
			resolve(value);
			if (!this.#stopped) this.ui.requestRender();
		};
		const paste = async (path?: string): Promise<boolean> => {
			const deliver = editor.beginPaste();
			let text: string | undefined;
			try {
				if (!this.host.readPromptPaste) throw new Error("Image paste is unavailable in this host");
				const value = await this.host.readPromptPaste(path);
				if (!editor.acceptsImages) return false;
				text = value.text;
				for (const image of value.images ?? []) text += editor.attachImage(image) ?? "";
				if (!text) throw new Error("Clipboard contains no image or text");
				form.error = undefined;
				return true;
			} catch (error) {
				if (editor.acceptsImages)
					form.error = sanitizeDisplayText(error instanceof Error ? error.message : "Image paste failed");
				return false;
			} finally {
				deliver(text);
				if (!this.#stopped) this.ui.requestRender();
			}
		};
		const editor = new HookEditorComponent(
			this.ui,
			prompt.title,
			prefill?.text,
			(text, images) => finish({ text, images }),
			() => finish(undefined),
			{
				promptStyle: true,
				question: prompt.question,
				acceptImages: true,
				images: prefill?.images,
				onPasteImage: () => paste(),
				onPasteImagePath: async path => {
					await paste(path);
				},
				maxHeight: Math.max(3, this.ui.terminal.rows - 16),
			},
		);
		form.prompt = { component: editor, resolve: finish, paste: () => paste() };
		form.view.setScrollOffset(0);
		this.ui.requestRender();
		return promise;
	}

	async #send(entry: CentralQueueEntry<CentralForm>): Promise<void> {
		const form = entry.draft!;
		if (form.sending || form.answer === undefined || !this.#queue.has(entry)) return;
		// Its chat refuses actions until it answers a poll again; the saved answer stays.
		const unresponsive = this.focus ? this.#focusUnresponsive(entry.chat) : undefined;
		if (unresponsive) {
			form.error = `${this.#chatLabel(entry.chat)} is not responding (${unresponsive}); nothing was sent. Enter retries once it responds.`;
			this.ui.requestRender();
			return;
		}
		form.sending = true;
		form.error = undefined;
		this.ui.requestRender();
		try {
			await this.host.answer(entry.chat.id, entry.request.id, form.answer);
			if (this.#stopped) return;
			this.#queue.accept(entry);
			this.#disposeForm(form);
			this.#followQueueCurrent();
		} catch (error) {
			if (this.#stopped) return;
			form.error = `Answer not accepted: ${sanitizeDisplayLine(String(error))}. Enter retries the saved answer; Ctrl+O opens the chat.`;
		} finally {
			form.sending = false;
			if (!this.#stopped) this.ui.requestRender();
		}
	}

	async #open(chatId: string): Promise<void> {
		if (this.#opening) return;
		this.#opening = true;
		this.#openError = undefined;
		try {
			await this.host.open(chatId);
		} catch (error) {
			this.#openError = `Cannot open original chat: ${sanitizeDisplayLine(String(error))}. Switch to its terminal manually.`;
		} finally {
			this.#opening = false;
			if (!this.#stopped) this.ui.requestRender();
		}
	}

	#selectAdjacent(direction: -1 | 1): void {
		const queued = [...this.#queue.orderedChatIds];
		const queuedSet = new Set(queued);
		const ids = [...queued, ...this.#snapshot.chats.map(chat => chat.id).filter(id => !queuedSet.has(id))];
		if (ids.length === 0) return;
		const current = Math.max(0, ids.indexOf(this.#selectedChatId ?? ids[0]!));
		const next = ids[(current + direction + ids.length) % ids.length]!;
		this.#selectChat(next, true);
	}

	/** Focus pointer: a click focuses the composer or question on release; a drag selects text and copies it. */
	#focusPointer(event: SgrMouseEvent): void {
		if (event.leftClick) {
			this.#clearSelection();
			const region = event.col < this.#mainWidth ? this.#regionAt(event.row) : undefined;
			this.#press = {
				row: event.row,
				col: event.col,
				region: region?.kind,
				point: region ? this.#pointAt(region, event.row, event.col) : { line: 0, col: 0 },
			};
			this.ui.requestRender();
		} else if (event.motion && (event.button & 3) === 0) {
			const press = this.#press;
			if (!press?.region) return;
			if (!this.#selection) {
				// A press and release on one cell is a click, never a selection.
				if (event.row === press.row && event.col === press.col) return;
				this.#selectRegions.find(region => region.kind === press.region)?.view?.setFollowTail(false);
				this.#selection = {
					region: press.region,
					anchor: press.point,
					head: press.point,
					dragging: true,
					first: press.point.line,
					rows: [],
				};
			}
			this.#dragTo(event.row, event.col);
		} else if (event.release && (event.button & 3) === 0) {
			const press = this.#press;
			const selection = this.#selection;
			this.#press = undefined;
			this.#stopEdgeScroll();
			if (selection?.dragging) {
				selection.dragging = false;
				const region = this.#selectRegions.find(candidate => candidate.kind === selection.region);
				const regionView = region?.view;
				if (regionView) regionView.setFollowTail(regionView.getScrollOffset() >= regionView.getMaxScrollOffset());
				const text = region ? selectionText(region.lines, selection.anchor, selection.head) : "";
				if (text.trim()) void this.#copy(text);
				else this.#selection = undefined;
			} else if (press && press.col < this.#mainWidth) {
				if (press.row >= this.#inputTop && press.row < this.#inputBottom) this.#inputFocus = true;
				else if (press.row >= this.#questionTop && press.row < this.#inputTop) this.#inputFocus = false;
			}
			this.ui.requestRender();
		}
	}

	#regionAt(row: number): FocusSelectRegion | undefined {
		return this.#selectRegions.find(
			region => region.height > 0 && row >= Math.max(0, region.top) && row < region.top + region.height,
		);
	}

	/** The region row under frame row `row`; past an edge, the first or last visible row's start or end. */
	#pointAt(region: FocusSelectRegion, row: number, col: number): SelectionPoint {
		const offset = region.view?.getScrollOffset() ?? 0;
		const visibleTop = Math.max(0, region.top);
		const point =
			row < visibleTop
				? { line: offset + visibleTop - region.top, col: 0 }
				: row >= region.top + region.height
					? { line: offset + region.height - 1, col: Number.POSITIVE_INFINITY }
					: { line: offset + row - region.top, col };
		point.line = Math.max(0, Math.min(point.line, region.lines.length - 1));
		return point;
	}

	/** Move the selection head; past the region's top or bottom edge, scroll it and keep scrolling while held there. */
	#dragTo(row: number, col: number): void {
		const selection = this.#selection;
		const region = this.#selectRegions.find(candidate => candidate.kind === selection?.region);
		if (!selection?.dragging || !region) return;
		const visibleTop = Math.max(0, region.top);
		const bottom = region.top + region.height - 1;
		const beyond = row < visibleTop ? row - visibleTop : row > bottom ? row - bottom : 0;
		if (beyond !== 0) region.view?.scroll(Math.sign(beyond) * Math.min(3, Math.abs(beyond)));
		selection.head = this.#pointAt(region, row, col);
		const [start, end] = orderedSelection(selection.anchor, selection.head);
		selection.first = start.line;
		selection.rows = region.lines.slice(start.line, end.line + 1).map(plainRow);
		if (beyond !== 0 && region.view) {
			if (!this.#edgeScroll) {
				const timer = setInterval(() => {
					if (this.#edgeScroll) this.#dragTo(this.#edgeScroll.row, this.#edgeScroll.col);
				}, 100);
				timer.unref?.();
				this.#edgeScroll = { timer, row, col };
			}
			this.#edgeScroll.row = row;
			this.#edgeScroll.col = col;
		} else this.#stopEdgeScroll();
		this.ui.requestRender();
	}

	#stopEdgeScroll(): void {
		if (this.#edgeScroll) clearInterval(this.#edgeScroll.timer);
		this.#edgeScroll = undefined;
	}

	#clearSelection(): void {
		this.#selection = undefined;
		this.#press = undefined;
		this.#stopEdgeScroll();
	}

	async #copy(text: string): Promise<void> {
		const count = [...text].length;
		this.#copyStatus = {
			text: `Copied ${count} char${count === 1 ? "" : "s"}`,
			error: false,
			until: this.#now() + 3000,
		};
		this.ui.requestRender();
		try {
			await this.focus!.copyToClipboard(text);
		} catch (error) {
			this.#copyStatus = {
				text: `Copy failed: ${sanitizeDisplayLine(error instanceof Error ? error.message : String(error))}`,
				error: true,
				until: this.#now() + 5000,
			};
			if (!this.#stopped) this.ui.requestRender();
		}
	}

	/**
	 * Reverse-video the selected cells in this frame's rows. The selection ends when
	 * the rows under it no longer show the text it was made on (new turns, a reload,
	 * a resize), so it never copies or marks other text, and once it scrolls out of view.
	 */
	#paintSelection(frame: string[], cut: number): void {
		const selection = this.#selection;
		if (!selection) return;
		const region = this.#selectRegions.find(candidate => candidate.kind === selection.region);
		const changed =
			!region ||
			selection.rows.some((text, index) => {
				const source = region.lines[selection.first + index];
				return source === undefined || plainRow(source) !== text;
			});
		const offset = region?.view?.getScrollOffset() ?? 0;
		const [start, end] = orderedSelection(selection.anchor, selection.head);
		const firstVisible = offset + Math.max(0, -(region?.top ?? 0));
		const lastVisible = offset + (region?.height ?? 0) - 1;
		if (!region || changed || (!selection.dragging && (end.line < firstVisible || start.line > lastVisible))) {
			this.#clearSelection();
			return;
		}
		for (let index = Math.max(0, -region.top); index < region.height; index++) {
			const line = offset + index;
			const source = region.lines[line];
			if (source === undefined) continue;
			const cells = rowSelection(line, start, end, plainRow(source), isOsc66Line(source));
			const at = region.top + cut + index;
			if (cells) frame[at] = highlightRow(frame[at]!, cells.from, cells.to, cells.text);
		}
	}

	handleInput(data: string): void {
		this.#routeInput(data);
		// A card the keyboard went into (arrow, F2, click, Tab or by itself) is no longer new.
		if (this.focus && !this.#inputFocus && !this.#showRetired) {
			const shown = this.#focusEntry()?.key;
			this.#focusNew = this.#focusNew.filter(key => key !== shown);
		}
	}

	#routeInput(data: string): void {
		this.#lastInputAt = this.#now();
		if (
			data.startsWith("\x1b[<") &&
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					const entry = this.#showRetired ? this.#retired : this.#entryForSelectedChat();
					const form = entry ? this.#form(entry) : undefined;
					const view = form && event.row >= this.#questionTop ? form.view : this.#transcriptView;
					view.setFollowTail(false);
					view.scroll(event.wheel * 3);
					view.setFollowTail(view.getScrollOffset() >= view.getMaxScrollOffset());
					this.ui.requestRender();
				} else if (this.focus) this.#focusPointer(event);
				else if (event.leftClick && event.col < this.#mainWidth) {
					if (event.row >= this.#inputTop && event.row < this.#inputBottom) this.#inputFocus = true;
					else if (event.row >= this.#questionTop && event.row < this.#inputTop) this.#inputFocus = false;
					this.ui.requestRender();
				}
				return true;
			})
		)
			return;
		// Any key ends a mouse selection; the key itself is handled as usual.
		if (this.#selection || this.#press) {
			this.#clearSelection();
			this.ui.requestRender();
		}
		// Focus: the first key after a question took the keyboard by itself. Text, a
		// paste, Enter or Backspace within FOCUS_AUTO_GRACE_MS was typed for the
		// composer as the switch happened, so it goes there with the keyboard, and
		// the question is marked new again (it retakes the keyboard once input is
		// quiet). Any other key, or one after the window, belongs to the card.
		if (this.#autoFocusAt !== undefined) {
			const switchedAt = this.#autoFocusAt;
			this.#autoFocusAt = undefined;
			const shown = this.#inputFocus || this.#showRetired ? undefined : this.#focusEntry();
			const composerKey =
				matchesKey(data, "enter") ||
				matchesKey(data, "backspace") ||
				data.startsWith("\x1b[200~") ||
				decodePrintableKey(data) !== undefined ||
				(!data.startsWith("\x1b") && [...data].every(char => char >= " " && char !== "\x7f"));
			if (shown && !formInUse(shown.draft) && this.#now() - switchedAt < FOCUS_AUTO_GRACE_MS && composerKey) {
				this.#inputFocus = true;
				this.#focusNew = [shown.key, ...this.#focusNew.filter(key => key !== shown.key)];
			}
		}
		if (matchesKey(data, "ctrl+c")) {
			this.#finished.resolve();
			return;
		}
		if (this.focus && matchesKey(data, "ctrl+x")) {
			const reply = this.#focusTurns?.findLast(turn => turn.kind === "reply");
			if (reply) void this.#copy(reply.text);
			else this.#copyStatus = { text: "No reply to copy yet", error: true, until: this.#now() + 3000 };
			this.ui.requestRender();
			return;
		}
		if (matchesKey(data, "alt+up") || matchesKey(data, "alt+down")) {
			this.#usageOffset = Math.max(
				0,
				Math.min(this.#usageMaxOffset, this.#usageOffset + (matchesKey(data, "alt+up") ? -1 : 1)),
			);
			this.ui.requestRender();
			return;
		}
		// Focus: F8 shows the kept draft of a question that ended elsewhere, read-only,
		// in place of the question card; F8 or Esc goes back, F9 discards it. Keys
		// meanwhile go to the composer, so nothing typed can reach a question the card
		// no longer shows. F9 is bound nowhere else, so it never takes a composer key.
		if (this.focus && matchesKey(data, "f8") && (this.#showRetired || this.#retired?.draft)) {
			this.#showRetired = !this.#showRetired;
			if (this.#showRetired) this.#retiredViewed = true;
			this.ui.requestRender();
			return;
		}
		if (this.focus && this.#showRetired && matchesKey(data, "f9")) {
			this.#discardRetired();
			this.ui.requestRender();
			return;
		}
		if (
			this.focus &&
			this.#showRetired &&
			matchesKey(data, "escape") &&
			!this.#drafts.get(FOCUS_DRAFT_KEY)?.input.isShowingAutocomplete()
		) {
			this.#showRetired = false;
			this.ui.requestRender();
			return;
		}
		const entry = this.focus && this.#showRetired ? undefined : this.#entryForSelectedChat();
		const form = entry ? this.#form(entry) : undefined;
		// Focus: from a question card, its own chat (it may not be the focused one).
		const openChatId = this.focus && form && !this.#inputFocus ? entry!.chat.id : this.#selectedChatId;
		if (matchesKey(data, "ctrl+o") && openChatId) {
			void this.#open(openChatId);
			return;
		}
		if (matchesKey(data, "f2") && form) {
			this.#inputFocus = !this.#inputFocus;
			this.ui.requestRender();
			return;
		}
		// Focus composer completion popup: its navigation and accept keys belong to the
		// editor, so Enter completes a partly typed name instead of sending, and arrows
		// move the selection instead of handing focus to a question. Tab completes too.
		// Enter on a name already typed in full only adds a space, so it sends as usual.
		if (this.focus && (this.#inputFocus || !form)) {
			const draft = this.#draft(FOCUS_DRAFT_KEY);
			const popupKey =
				matchesKey(data, "enter") ||
				matchesKey(data, "up") ||
				matchesKey(data, "down") ||
				matchesKey(data, "pageUp") ||
				matchesKey(data, "pageDown") ||
				matchesKey(data, "escape");
			if (matchesKey(data, "tab") || (popupKey && draft.input.isShowingAutocomplete())) {
				const before = draft.input.getText();
				draft.input.handleDraftEdit(data);
				const after = draft.input.getText();
				if (after !== before) draft.version++;
				this.ui.requestRender();
				if (!matchesKey(data, "enter") || after.trimEnd() !== before.trimEnd()) return;
			}
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			const direction = matchesKey(data, "shift+tab") ? -1 : 1;
			if (!this.focus) this.#selectAdjacent(direction);
			// Focus: from a question card (the composer's Tab completes), the next open question.
			else if (form && !this.#inputFocus && !form.prompt) {
				this.#cycleFocusEntry(direction);
				this.ui.requestRender();
			}
			return;
		}
		// Focus: an arrow key on an empty composer moves keyboard focus into the
		// open question (and moves its selection); Enter then answers it. Enter,
		// Esc, Space, digits and typing on the composer never touch a question,
		// since the chat treats any answer as Shreyan's decision.
		if (
			this.focus &&
			this.#inputFocus &&
			form &&
			!form.prompt &&
			form.answer === undefined &&
			!form.sending &&
			!this.#draft(FOCUS_DRAFT_KEY).input.hasDraftContent() &&
			!this.#focusUnresponsive(entry!.chat) &&
			(matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "left") || matchesKey(data, "right"))
		) {
			this.#inputFocus = false;
			form.touched = true;
			form.component.handleInput?.(data);
			this.ui.requestRender();
			return;
		}
		// Esc in a focused question returns to the composer instead of cancelling it.
		if (this.focus && !this.#inputFocus && form && !form.prompt && matchesKey(data, "escape")) {
			this.#inputFocus = true;
			this.ui.requestRender();
			return;
		}
		const inputFocused = this.#inputFocus || !form;
		if (
			inputFocused &&
			(this.#selectedChatId || this.focus) &&
			!matchesKey(data, "shift+up") &&
			!matchesKey(data, "shift+down")
		) {
			const chat = this.#snapshot.chats.find(candidate => candidate.id === this.#selectedChatId);
			const draftKey = this.focus ? FOCUS_DRAFT_KEY : chat?.id;
			if (draftKey) {
				const draft = this.#draft(draftKey);
				const missing = `${this.#focusLabel()} is not available; draft kept, retrying.`;
				if (matchesKey(data, "enter") && data !== "\n") {
					const command = this.focus ? parseFocusCommand(draft.input.getExpandedText()) : undefined;
					if (command?.name === "remote") {
						if (chat) void this.#sendCommand(chat, draft);
						else draft.error = missing;
					} else if (command) void this.#runFocusCommand(command, draft);
					else if (chat) void this.#sendPrompt(chat, draft);
					else draft.error = missing;
				} else if (matchesKey(data, "ctrl+r") && draft.pending) {
					if (!chat) draft.error = missing;
					else if (draft.pending.command) void this.#sendCommand(chat, draft, true);
					else void this.#sendPrompt(chat, draft, true);
				} else {
					const before = draft.input.getText();
					const pasteEnd = data.indexOf("\x1b[201~");
					const split = pasteEnd < 0 ? data.length : pasteEnd + "\x1b[201~".length;
					const editorInput = data.slice(0, split);
					draft.input.handleDraftEdit(matchesKey(editorInput, "shift+enter") ? "\n" : editorInput);
					if (draft.input.getText() !== before) draft.version++;
					if (split < data.length) this.handleInput(data.slice(split));
				}
			}
			this.ui.requestRender();
			return;
		}
		if (
			form &&
			this.#questionVisibleFor !== entry &&
			!matchesKey(data, "shift+up") &&
			!matchesKey(data, "shift+down")
		) {
			this.ui.requestRender();
			return;
		}
		const transcriptScrollKey =
			(!form &&
				(matchesKey(data, "up") ||
					matchesKey(data, "down") ||
					matchesKey(data, "home") ||
					matchesKey(data, "end"))) ||
			matchesKey(data, "shift+up") ||
			matchesKey(data, "shift+down");
		if (transcriptScrollKey) {
			const view = this.#transcriptView;
			if (matchesKey(data, "home")) view.scrollToTop();
			else if (matchesKey(data, "end")) view.scrollToBottom();
			else view.handleScrollKey(data);
			view.setFollowTail(view.getScrollOffset() >= view.getMaxScrollOffset());
		} else if (!form?.prompt && matchesKey(data, "escape")) {
			if (!form?.sending && entry) this.#skipChat(entry.chat.id);
		} else if (form && !form.sending && !(this.focus && this.#focusUnresponsive(entry!.chat))) {
			if (form.answer !== undefined) {
				if (matchesKey(data, "enter")) void this.#send(entry!);
			} else {
				form.touched = true;
				if (form.prompt) {
					const bindings = getKeybindings();
					const pasteKey =
						bindings.getDefinition("app.clipboard.pasteImage") !== undefined
							? bindings.matches(data, "app.clipboard.pasteImage")
							: getDefaultPasteImageKeys().some(key => matchesKey(data, key));
					if (pasteKey) void form.prompt.paste();
					else form.prompt.component.handleInput(data);
				} else form.component.handleInput?.(data);
			}
		}
		this.ui.requestRender();
	}

	#rosterChats(): CentralChat[] {
		const byId = new Map(this.#snapshot.chats.map(chat => [chat.id, chat]));
		const queued = [...this.#queue.orderedChatIds]
			.map(id => byId.get(id))
			.filter((chat): chat is CentralChat => chat !== undefined);
		const queuedIds = new Set(queued.map(chat => chat.id));
		return [...queued, ...this.#snapshot.chats.filter(chat => !queuedIds.has(chat.id))];
	}

	#rosterLines(height: number, width: number): string[] {
		const chats = this.#rosterChats();
		const lines = [
			theme.bold(
				theme.fg("accent", `CHATS · ${this.#snapshot.chats.length} active · ${this.#queue.chatCount} queued`),
			),
		];
		const maxChatRows = Math.max(0, height - 1);
		const overflow = chats.length * 2 > maxChatRows;
		const chatLimit = overflow ? Math.max(0, Math.floor(Math.max(0, maxChatRows - 1) / 2)) : chats.length;
		for (const chat of chats.slice(0, chatLimit)) {
			lines.push(
				`${chat.id === this.#selectedChatId ? "❯" : " "} ${chat.busy ? "●" : "○"} ${sanitizeDisplayLine(chat.name) || "Untitled chat"}`,
				`  ${chat.requests.length ? `${chat.requests.length} question${chat.requests.length === 1 ? "" : "s"} waiting` : "no question"}`,
			);
		}
		if (overflow) lines.push(theme.fg("dim", `+${chats.length - chatLimit} more`));
		return lines.map(line => truncateToWidth(line, width));
	}

	#compactRoster(width: number): string[] {
		const chats = this.#rosterChats();
		const names = chats
			.slice(0, 3)
			.map(chat => `${chat.id === this.#selectedChatId ? "❯" : ""}${sanitizeDisplayLine(chat.name) || "Untitled"}`);
		const more = chats.length - names.length;
		return [
			truncateToWidth(
				theme.fg("accent", `CHATS ${this.#snapshot.chats.length} active · ${this.#queue.chatCount} queued`),
				width,
			),
			truncateToWidth(theme.fg("dim", `Queue: ${names.join(" · ")}${more > 0 ? ` · +${more} more` : ""}`), width),
		];
	}

	render(width: number): readonly string[] {
		const height = Math.max(1, this.ui.terminal.rows);
		const focus = this.focus;
		const sidebarWidth = !focus && width >= 80 ? Math.min(32, Math.max(26, Math.floor(width * 0.28))) : 0;
		const mainWidth = Math.max(1, width - (sidebarWidth > 0 ? sidebarWidth + 3 : 0));
		const entry = this.#showRetired ? this.#retired : this.#entryForSelectedChat();
		const form = entry ? this.#form(entry) : undefined;
		// Focus: every chat's open questions, in order; the card's own chat may not answer now.
		const focusEntries = focus && !this.#showRetired ? this.#focusEntries() : [];
		const cardUnresponsive = focus && entry && !this.#showRetired ? this.#focusUnresponsive(entry.chat) : undefined;
		const compactQuestion = !!form && (height < 20 || width < 80);
		const compactRosterRows = !focus && sidebarWidth === 0 && height >= 12 && !compactQuestion ? 1 : 0;
		this.#statusWidth = Math.min(512, mainWidth);
		this.#usageWidth = Math.max(1, Math.min(512, sidebarWidth || width));
		void this.#loadWorkspace();
		// Focus shows the chat's replies and questions only; quotas stay in Central.
		const usageRows = focus
			? []
			: workspaceLines(
					this.#workspace?.usageLines.length
						? this.#workspace.usageLines
						: [this.#workspaceError ? "Usage unavailable · source chat needs current OMP" : "Usage unavailable"],
					this.#usageWidth,
				);
		const usageHeight = Math.min(usageRows.length, compactQuestion ? 1 : height >= 5 ? Math.max(1, height - 10) : 0);
		this.#usageMaxOffset = Math.max(0, usageRows.length - usageHeight);
		this.#usageOffset = Math.min(this.#usageOffset, this.#usageMaxOffset);
		const usage = usageRows.slice(this.#usageOffset, this.#usageOffset + usageHeight);
		const compactUsageRows = sidebarWidth === 0 ? usage.length : 0;
		const contentHeight = Math.max(1, height - compactRosterRows - compactUsageRows);
		this.#questionBudget = Math.max(1, contentHeight - (compactQuestion ? 5 : 14));
		const busyCount = this.#snapshot.chats.filter(chat => chat.busy).length;
		const selectedChat = this.#snapshot.chats.find(chat => chat.id === this.#selectedChatId);
		const otherQuestions = focusEntries.filter(other => other.chat.id !== selectedChat?.id).length;
		const heading = focus
			? `OMP Focus  ·  ${this.#focusLabel()}  ·  ${selectedChat ? `${sanitizeDisplayLine(selectedChat.source ?? "local")}  ·  ${selectedChat.busy ? "busy" : "idle"}  ·  ${selectedChat.requests.length} open question${selectedChat.requests.length === 1 ? "" : "s"}` : "not connected"}${otherQuestions ? `  ·  ${otherQuestions} from other chats` : ""}`
			: `OMP Central  ·  ${this.#snapshot.chats.length} active  ·  ${this.#queue.chatCount} waiting  ·  ${busyCount} busy`;
		const identity = selectedChat
			? `${sanitizeDisplayLine(selectedChat.name) || "Untitled chat"}  ·  ${sanitizeDisplayLine(selectedChat.source ?? "local")}  ·  ${sanitizeDisplayLine(selectedChat.cwd)}`
			: focus
				? `Following "${sanitizeDisplayLine(focus.target)}"`
				: `${this.#snapshot.chats.length} active chats`;
		const body: string[] = [];
		const wrapError = (text: string): void => {
			body.push(...wrapTextWithAnsi(theme.fg("error", sanitizeDisplayText(text)), Math.max(1, mainWidth - 2)));
		};
		if (focus) {
			// One notice about the target replaces every other host's errors.
			const notice =
				this.#focusNotice ??
				(this.#transcriptError
					? `${this.#focusLabel()}: not responding; retrying (${this.#transcriptError})`
					: undefined);
			if (notice) wrapError(notice);
			if (this.#openError) wrapError(this.#openError);
		} else {
			for (const error of this.#snapshot.errors) wrapError(error);
			if (this.#openError) wrapError(this.#openError);
			if (this.#transcriptError) wrapError(this.#transcriptError);
		}
		let formStart = Number.POSITIVE_INFINITY;
		if (form) {
			if (form.error) body.push(...wrapTextWithAnsi(theme.fg("error", form.error), Math.max(1, mainWidth - 2)));
			if (form.sending) body.push(theme.fg("muted", "Sending answer…"));
			if (cardUnresponsive)
				body.push(
					...wrapTextWithAnsi(
						theme.fg(
							"warning",
							`${this.#chatLabel(entry!.chat)} is not responding (${sanitizeDisplayLine(cardUnresponsive)}); its last-known question is shown and can be answered once it responds again.`,
						),
						Math.max(1, mainWidth - 2),
					),
				);
			formStart = body.length;
			if (form.details && entry) {
				const request = entry.request;
				const text =
					request.kind === "ask"
						? request.questions
								.map(question =>
									[
										question.question,
										...question.options.map(option =>
											[option.label, option.description, option.preview].filter(Boolean).join("\n"),
										),
									].join("\n\n"),
								)
								.join("\n\n")
						: request.kind === "select"
							? [
									request.title,
									...request.options.map(option =>
										typeof option === "string"
											? option
											: [option.label, option.description].filter(Boolean).join("\n"),
									),
								].join("\n\n")
							: request.title;
				body.push(...wrapTextWithAnsi(sanitizeDisplayText(text), Math.max(1, mainWidth - 2)));
			} else if (form.answer !== undefined) {
				const text =
					typeof form.answer === "string"
						? form.answer
						: form.answer.kind === "chat"
							? "Discuss in chat"
							: form.answer.results
									.map(result =>
										[
											result.question,
											...result.selectedOptions,
											result.customInput,
											result.note ? `Note: ${result.note}` : undefined,
										]
											.filter(Boolean)
											.join("\n"),
									)
									.join("\n\n");
				body.push(...wrapTextWithAnsi(sanitizeDisplayText(text), Math.max(1, mainWidth - 2)));
			} else {
				const component = form.prompt?.component ?? form.component;
				if ("focused" in component)
					component.focused =
						this.focused && !this.#inputFocus && !this.#showRetired && !form.sending && !cardUnresponsive;
				body.push(...component.render(Math.max(1, mainWidth - 2)));
			}
		}
		// Focus announces an ended question once, as an entry in the flow, not here.
		if (!focus && !form && this.#retired) body.push(theme.fg("muted", "Question ended elsewhere; draft not sent"));
		const questionBody = body;
		// Focus: commands and ended questions are dated entries in the flow, merged by time.
		const focusRows = focus
			? this.#renderFocusRows(Math.max(1, mainWidth - 2), selectedChat?.busy === true)
			: undefined;
		const transcriptRows = focusRows
			? focusRows.rows
			: this.#transcriptLoading && !this.#transcriptBuilder
				? [theme.fg("muted", "Loading chat transcript…")]
				: (this.#transcriptBuilder?.container.render(Math.max(1, mainWidth - 2)) ?? []);
		const status = focus
			? []
			: workspaceLines(this.#workspace?.statusLines ?? [], mainWidth).slice(
					0,
					compactQuestion ? 1 : Math.max(1, Math.min(3, contentHeight - 8)),
				);
		if (!focus && status.length === 0 && !this.#workspace?.composer)
			status.push(truncateToWidth(theme.fg("dim", this.#workspaceError ?? "Status unavailable"), mainWidth));
		const draft = focus ? this.#draft(FOCUS_DRAFT_KEY) : selectedChat ? this.#draft(selectedChat.id) : undefined;
		// The kept draft of an ended question is read-only; keys go to the composer.
		const inputFocused = this.#inputFocus || !form || (!!focus && this.#showRetired);
		const inputHeight = compactQuestion
			? 1
			: Math.max(1, Math.min(5, contentHeight - status.length - (this.#usageMaxOffset ? 2 : 1) - 3));
		if (draft) {
			draft.input.focused = this.focused && inputFocused;
			draft.input.setBorderVisible(inputHeight >= 3);
			draft.input.setMaxHeight(inputHeight);
			draft.input.setBorderStyle(this.#workspace?.composer?.shape ?? "band");
			draft.input.setTopBorder(this.#workspace?.composer?.topBorder);
		}
		const input = draft?.input.render(mainWidth) ?? [theme.fg("dim", "No chat selected")];
		const sendState = draft?.sending
			? draft.pending?.command
				? "Running in the chat…"
				: "Sending…"
			: this.#focusCommandRunning
				? "Running local command…"
				: (draft?.error ?? this.#promptUnavailable());
		const canSend = this.#workspace?.canPrompt && this.host.prompt;
		const copyStatus = this.#copyStatus && this.#copyStatus.until > this.#now() ? this.#copyStatus : undefined;
		// Focus: questions that have not had the keyboard yet are marked new until they take it.
		const freshEntries = focusEntries.filter(other => this.#focusNew.includes(other.key));
		const shownNew = !!entry && inputFocused && freshEntries.includes(entry);
		const otherNew = freshEntries.filter(other => other !== entry);
		const answerKeys = draft?.input.hasDraftContent() ? "F2" : "↓ or F2";
		const focusQuestionHint = this.#showRetired
			? `${this.#focusNew.length ? "new question waiting · " : ""}F8/Esc back · F9 discard · `
			: !form
				? ""
				: inputFocused
					? shownNew && !cardUnresponsive
						? `new question: ${answerKeys} to answer · `
						: draft?.input.hasDraftContent() || cardUnresponsive
							? "F2 question · "
							: "↑/↓ question · "
					: `${cardUnresponsive ? "not responding" : "Enter answer"} · Esc back to input · ${focusEntries.length > 1 ? "Tab/Shift+Tab next question · " : ""}`;
		const hint = focus
			? `${focusQuestionHint}${inputFocused ? (canSend ? "Enter send (focus) · Shift+Enter newline" : "Send unavailable") : "←/→ questions"} · / commands · /help · drag to copy · Ctrl+X copy reply · Shift+↑/↓ scroll · Ctrl+O open · Ctrl+C close`
			: `${form ? `F2 ${inputFocused ? "question" : "input"} · ` : ""}Ctrl+O open · Tab/Shift+Tab chats · ${inputFocused ? (canSend ? "Enter send · Shift+Enter newline" : "Send unavailable") : "←/→ questions"} · Shift+↑/↓ scroll · Ctrl+C close`;
		const footer = [
			...input,
			...status,
			truncateToWidth(
				copyStatus
					? theme.fg(copyStatus.error ? "error" : "success", copyStatus.text)
					: theme.fg(sendState ? "muted" : "dim", sendState ?? hint),
				mainWidth,
			),
			...(this.#usageMaxOffset ? [truncateToWidth(theme.fg("dim", "Alt+↑/↓ usage"), mainWidth)] : []),
		];
		const headerRows = !compactQuestion && contentHeight >= footer.length + (form ? 7 : 5) ? 2 : 0;
		const contentBudget = Math.max(0, contentHeight - footer.length - headerRows);
		// While a command's entry is the newest in the flow, an open question card leaves
		// it up to a third of the screen, so the card never hides the output just shown.
		const minimumTranscriptHeight = Math.min(
			Math.max(compactQuestion ? 1 : 3, Math.min(focusRows?.tailRows ?? 0, Math.floor(contentHeight / 3))),
			contentBudget,
		);
		const questionHeight = Math.min(
			questionBody.length,
			Math.max(0, contentBudget - minimumTranscriptHeight - (compactQuestion ? 0 : 1)),
		);
		const questionHeaderRows = questionHeight > 0 && !compactQuestion ? 1 : 0;
		const transcriptHeight = Math.max(0, contentBudget - questionHeight - questionHeaderRows);
		this.#questionTop = compactRosterRows + headerRows + transcriptHeight + questionHeaderRows;
		this.#transcriptView.setHeight(transcriptHeight);
		this.#transcriptView.setLines(transcriptRows);
		const view = form?.view ?? this.#emptyView;
		view.setHeight(questionHeight);
		view.setLines(questionBody);
		const requiresControlMarker =
			!!form && form.answer === undefined && (form.prompt !== undefined || entry?.request.kind !== "ask");
		// A question that just took the keyboard by itself: show its control (the
		// cursor row, or an ask card's first row), scrolling as little as possible.
		if (this.#revealCard && form && questionHeight > 0) {
			this.#revealCard = false;
			const marker = requiresControlMarker ? questionBody.findIndex(line => line.includes(CURSOR_MARKER)) : -1;
			const row = marker >= 0 ? marker : formStart;
			view.setScrollOffset(row < questionHeight ? 0 : marker >= 0 ? row - questionHeight + 1 : row);
		}
		const visibleQuestionRows = questionBody.slice(view.getScrollOffset(), view.getScrollOffset() + questionHeight);
		this.#questionVisibleFor =
			questionHeight > 0 &&
			(requiresControlMarker
				? visibleQuestionRows.some(line => line.includes(CURSOR_MARKER))
				: formStart < view.getScrollOffset() + questionHeight)
				? entry
				: undefined;
		const focusIndex = entry ? focusEntries.indexOf(entry) : -1;
		const questionLabel = !focus
			? `${inputFocused ? "question" : "question focused"}${this.#retired ? " · question ended elsewhere; draft retained" : ""}`
			: this.#showRetired
				? `kept draft · ${entry ? this.#chatLabel(entry.chat) : "its"} question ended elsewhere · not sent · F8 back · F9 discard`
				: `${shownNew ? "new question" : "question"}${focusEntries.length > 1 ? ` ${focusIndex + 1} of ${focusEntries.length}` : ""}${entry ? ` · ${this.#chatLabel(entry.chat)}` : ""}${cardUnresponsive ? " · not responding" : ""}${inputFocused ? "" : " · focused"}${shownNew && !cardUnresponsive ? ` · ${answerKeys} to answer` : ""}${otherNew.length ? ` · new question from ${this.#chatLabel(otherNew[0]!.chat)}${otherNew.length > 1 ? ` +${otherNew.length - 1}` : ""}` : ""}`;
		const markNew = shownNew || otherNew.length > 0 || (!!focus && this.#showRetired && this.#focusNew.length > 0);
		const headerBlock = headerRows
			? [truncateToWidth(theme.fg("muted", heading), mainWidth), truncateToWidth(identity, mainWidth)]
			: [];
		const transcriptBlock = this.#transcriptView.render(mainWidth).slice(0, transcriptHeight);
		const questionHeaderLabel = `── ${questionLabel} ──`;
		const questionHeaderBlock = questionHeaderRows
			? [
					truncateToWidth(
						markNew ? theme.bold(theme.fg("warning", questionHeaderLabel)) : theme.fg("dim", questionHeaderLabel),
						mainWidth,
					),
				]
			: [];
		const questionBlock = view.render(mainWidth).slice(0, questionHeight);
		const full = [...headerBlock, ...transcriptBlock, ...questionHeaderBlock, ...questionBlock, ...footer];
		const cut = Math.max(0, full.length - contentHeight);
		if (focus) {
			const questionAt = headerBlock.length + transcriptBlock.length + questionHeaderBlock.length;
			this.#selectRegions = [
				{
					kind: "transcript",
					lines: transcriptRows,
					top: headerBlock.length - cut,
					height: transcriptBlock.length,
					view: this.#transcriptView,
				},
				...(form
					? [
							{
								kind: "question" as const,
								lines: questionBody,
								top: questionAt - cut,
								height: questionBlock.length,
								view,
							},
						]
					: []),
			];
			this.#paintSelection(full, cut);
		}
		const main = full.slice(cut);
		this.#mainWidth = mainWidth;
		this.#inputTop = compactRosterRows + main.length - footer.length;
		this.#inputBottom = this.#inputTop + input.length;
		const rosterHeight = height - usage.length;
		const roster = this.#rosterLines(rosterHeight, sidebarWidth);
		while (roster.length < rosterHeight) roster.push("");
		roster.push(...usage);
		if (sidebarWidth === 0)
			return [...(compactRosterRows ? this.#compactRoster(width).slice(0, 1) : []), ...main, ...usage].slice(
				-height,
			);
		return Array.from({ length: height }, (_, index) => {
			const left = main[index] ?? "";
			const padded = left + " ".repeat(Math.max(0, mainWidth - visibleWidth(left)));
			return `${padded} ${theme.fg("dim", "│")} ${roster[index] ?? ""}`;
		});
	}

	invalidate(): void {
		for (const entry of this.#queue.entries) {
			entry.draft?.component.invalidate?.();
			entry.draft?.prompt?.component.invalidate?.();
			entry.draft?.view.invalidate();
		}
		this.#retired?.draft?.component.invalidate?.();
		this.#retired?.draft?.prompt?.component.invalidate?.();
		this.#retired?.draft?.view.invalidate();
		this.#emptyView.invalidate();
		for (const draft of this.#drafts.values()) draft.input.invalidate();
	}

	#disposeForm(form: CentralForm): void {
		form.component.dispose?.();
		form.prompt?.resolve(undefined);
		form.view.dispose();
	}

	dispose(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		clearTimeout(this.#timer);
		for (const entry of this.#queue.entries) if (entry.draft) this.#disposeForm(entry.draft);
		if (this.#retired?.draft) this.#disposeForm(this.#retired.draft);
		this.#emptyView.dispose();
		this.#transcriptBuilder?.dispose();
		this.#transcriptView.dispose();
		this.#clearSelection();
		for (const draft of this.#drafts.values()) draft.input.setShimmerRepaintHandler(undefined);
		this.#finished.resolve();
	}
}

/** Close only this fullscreen inbox; no cancellation is sent to a chat. */
export async function runCentralTui(
	host: CentralTuiHost,
	restart?: CentralRestartOptions,
	focus?: CentralFocusOptions,
): Promise<CentralExit> {
	const ui = new TUI(new ProcessTerminal());
	const component = new CentralComponent(ui, host, restart, focus);
	const overlay = ui.showOverlay(component, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
	});
	ui.setFocus(component);
	try {
		ui.start();
		return await component.run();
	} finally {
		component.dispose();
		overlay.hide();
		ui.stop();
	}
}
