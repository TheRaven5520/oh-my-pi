import { TUI, CURSOR_MARKER, type Component } from "../../tui";
import { ScrollView } from "../../components/scroll-view";
import { CustomEditor } from "../../prompt/custom-editor";
import { matchesKey } from "../../keys";
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
import { routeSgrMouseInput } from "../../mouse";
import { ProcessTerminal } from "../../terminal";
import { getEditorTheme, theme } from "../../theme/theme";
import { truncateToWidth, visibleWidth } from "../../utils";
import {
	CENTRAL_FOCUS_HELP,
	type CentralFocusCommand,
	type CentralFocusMemory,
	focusChatLines,
	focusTranscriptEntries,
	parseFocusCommand,
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

/** Focus mode keeps one draft for the target, whichever process currently serves it. */
const FOCUS_DRAFT_KEY = "\0focus";

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

interface CentralDraft {
	input: CustomEditor;
	version: number;
	sending: boolean;
	error?: string;
	pending?: { chatId: string; sessionId: string; requestId: string; text: string; version: number };
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
	#focusOutput: { title: string; lines: string[] } | undefined;
	#focusCommandRunning = false;

	constructor(
		readonly ui: TUI,
		readonly host: CentralTuiHost,
		readonly restart?: CentralRestartOptions,
		readonly focus?: CentralFocusOptions,
	) {
		this.#lastInputAt = this.#now();
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
		if (this.#retired?.draft) return false;
		for (const entry of this.#queue.entries) {
			const form = entry.draft;
			if (form && (form.touched || form.sending || form.answer !== undefined || form.prompt)) return false;
		}
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

	#retire(entries: CentralQueueEntry<CentralForm>[]): void {
		for (const entry of entries) {
			if (entry.draft?.touched && entry.draft.answer === undefined) {
				if (this.#retired?.draft) this.#disposeForm(this.#retired.draft);
				this.#retired = entry;
				this.#showRetired = false;
			} else if (entry.draft) this.#disposeForm(entry.draft);
		}
	}

	#focusLabel(): string {
		return sanitizeDisplayLine(this.#focusMemory.name ?? this.focus?.target ?? "") || "Untitled chat";
	}

	/**
	 * Follow the target across restarts: its session, then its name. Until it
	 * answers again, the last view, questions and draft stay where they are.
	 */
	#refreshFocus(snapshot: CentralSnapshot): void {
		const resolution = resolveFocusTarget(snapshot.chats, this.focus!.target, this.#focusMemory);
		if (resolution.kind === "ambiguous") {
			this.#focusNotice = resolution.message;
			return;
		}
		if (resolution.kind === "missing") {
			// No process serves the target, so its questions are gone with it.
			this.#retire(this.#queue.update([]));
			this.#focusNotice =
				this.#focusMemory.sessionId === undefined
					? resolution.message
					: `${this.#focusLabel()}: not responding; retrying (not listed by any host)`;
			return;
		}
		const chat = resolution.chat;
		this.#focusMemory = { sessionId: chat.sessionId, name: chat.name };
		this.#retire(this.#queue.update([chat]));
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

	#entryForSelectedChat(): CentralQueueEntry<CentralForm> | undefined {
		return this.#selectedChatId ? this.#queue.entryForChat(this.#selectedChatId) : this.#queue.current;
	}

	#followQueueCurrent(): void {
		if (this.focus) {
			// The view is pinned to the focused chat.
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
			const builder = new ChatTranscriptBuilder({ ui: this.ui, cwd, requestRender: () => this.ui.requestRender() });
			builder.rebuild(this.focus ? focusTranscriptEntries(entries) : entries);
			this.#transcriptBuilder?.dispose();
			this.#transcriptBuilder = builder;
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
				if (!this.#stopped) this.ui.requestRender();
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
		}
		return draft;
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
			await this.host.prompt!(pending.chatId, pending.sessionId, pending.requestId, pending.text);
			if (draft.version === pending.version) draft.input.setText("");
			draft.pending = undefined;
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

	/** Every `/…` input runs here; none of it reaches the focused chat. */
	async #runFocusCommand(command: CentralFocusCommand, draft: CentralDraft): Promise<void> {
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
		const show = (title: string, text: string | string[]): void => {
			const lines = typeof text === "string" ? text.replace(/\s+$/, "").split("\n") : text;
			this.#focusOutput = { title, lines: lines.some(Boolean) ? lines : ["(no output)"] };
			this.#transcriptView.setFollowTail(true);
			this.#transcriptView.scrollToBottom();
		};
		this.#focusCommandRunning = true;
		draft.error = undefined;
		this.ui.requestRender();
		try {
			switch (command.name) {
				case "help":
					show("/help", CENTRAL_FOCUS_HELP);
					break;
				case "chats":
					show("/chats", focusChatLines(this.#snapshot, this.#selectedChatId));
					break;
				case "dag":
					show("/dag", commands.boardUrl());
					break;
				case "inbox":
					show(`/inbox ${command.count}`, await commands.inbox(command.count));
					break;
				case "pause":
				case "resume":
					show(`/${command.name}`, await commands.setPaused(command.name === "pause"));
					break;
				case "send":
					show(`/send ${command.chat}`, await commands.relay(command.chat, command.message));
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

	handleInput(data: string): void {
		this.#lastInputAt = this.#now();
		if (
			data.startsWith("\x1b[<") &&
			routeSgrMouseInput(data, event => {
				if (event.leftClick && event.col < this.#mainWidth) {
					if (event.row >= this.#inputTop && event.row < this.#inputBottom) this.#inputFocus = true;
					else if (event.row >= this.#questionTop && event.row < this.#inputTop) this.#inputFocus = false;
					this.ui.requestRender();
				}
				if (event.wheel !== null) {
					const entry = this.#showRetired ? this.#retired : this.#entryForSelectedChat();
					const form = entry ? this.#form(entry) : undefined;
					const view = form && event.row >= this.#questionTop ? form.view : this.#transcriptView;
					view.setFollowTail(false);
					view.scroll(event.wheel * 3);
					view.setFollowTail(view.getScrollOffset() >= view.getMaxScrollOffset());
					this.ui.requestRender();
				}
				return true;
			})
		)
			return;
		if (matchesKey(data, "ctrl+c")) {
			this.#finished.resolve();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			// Focus shows one chat; there is nothing to cycle to.
			if (!this.focus) this.#selectAdjacent(matchesKey(data, "shift+tab") ? -1 : 1);
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
		const entry = this.#entryForSelectedChat();
		const form = entry ? this.#form(entry) : undefined;
		if (matchesKey(data, "ctrl+o") && this.#selectedChatId) {
			void this.#open(this.#selectedChatId);
			return;
		}
		if (matchesKey(data, "f2") && form) {
			this.#inputFocus = !this.#inputFocus;
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
					if (command) void this.#runFocusCommand(command, draft);
					else if (chat) void this.#sendPrompt(chat, draft);
					else draft.error = missing;
				} else if (matchesKey(data, "ctrl+r") && draft.pending) {
					if (chat) void this.#sendPrompt(chat, draft, true);
					else draft.error = missing;
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
		} else if (form && !form.sending) {
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
		const heading = focus
			? `OMP Focus  ·  ${this.#focusLabel()}  ·  ${selectedChat ? `${sanitizeDisplayLine(selectedChat.source ?? "local")}  ·  ${selectedChat.busy ? "busy" : "idle"}  ·  ${selectedChat.requests.length} open question${selectedChat.requests.length === 1 ? "" : "s"}` : "not connected"}`
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
					component.focused = this.focused && !this.#inputFocus && !this.#showRetired && !form.sending;
				body.push(...component.render(Math.max(1, mainWidth - 2)));
			}
		}
		if (!form && this.#retired) body.push(theme.fg("muted", "Question ended elsewhere; draft not sent"));
		const questionBody = body;
		const transcriptRows = [
			...(this.#transcriptLoading && !this.#transcriptBuilder
				? [theme.fg("muted", "Loading chat transcript…")]
				: (this.#transcriptBuilder?.container.render(Math.max(1, mainWidth - 2)) ?? [])),
			// Local command output follows the replies, newest at the bottom; it is never sent.
			...(focus && this.#focusOutput
				? [
						"",
						truncateToWidth(theme.fg("dim", `── ${this.#focusOutput.title} · local, not sent ──`), mainWidth),
						...this.#focusOutput.lines.flatMap(line =>
							wrapTextWithAnsi(sanitizeDisplayLine(line), Math.max(1, mainWidth - 2)),
						),
					]
				: []),
		];
		const status = focus
			? []
			: workspaceLines(this.#workspace?.statusLines ?? [], mainWidth).slice(
					0,
					compactQuestion ? 1 : Math.max(1, Math.min(3, contentHeight - 8)),
				);
		if (!focus && status.length === 0 && !this.#workspace?.composer)
			status.push(truncateToWidth(theme.fg("dim", this.#workspaceError ?? "Status unavailable"), mainWidth));
		const draft = focus ? this.#draft(FOCUS_DRAFT_KEY) : selectedChat ? this.#draft(selectedChat.id) : undefined;
		const inputFocused = this.#inputFocus || !form;
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
			? "Sending…"
			: this.#focusCommandRunning
				? "Running local command…"
				: (draft?.error ?? this.#promptUnavailable());
		const canSend = this.#workspace?.canPrompt && this.host.prompt;
		const hint = focus
			? `${form ? `F2 ${inputFocused ? "question" : "input"} · ` : ""}${inputFocused ? (canSend ? "Enter send (focus) · Shift+Enter newline" : "Send unavailable") : "←/→ questions · Esc input"} · /help commands · Shift+↑/↓ scroll · Ctrl+O open · Ctrl+C close`
			: `${form ? `F2 ${inputFocused ? "question" : "input"} · ` : ""}Ctrl+O open · Tab/Shift+Tab chats · ${inputFocused ? (canSend ? "Enter send · Shift+Enter newline" : "Send unavailable") : "←/→ questions"} · Shift+↑/↓ scroll · Ctrl+C close`;
		const footer = [
			...input,
			...status,
			truncateToWidth(theme.fg(sendState ? "muted" : "dim", sendState ?? hint), mainWidth),
			...(this.#usageMaxOffset ? [truncateToWidth(theme.fg("dim", "Alt+↑/↓ usage"), mainWidth)] : []),
		];
		const headerRows = !compactQuestion && contentHeight >= footer.length + (form ? 7 : 5) ? 2 : 0;
		const contentBudget = Math.max(0, contentHeight - footer.length - headerRows);
		const minimumTranscriptHeight = Math.min(compactQuestion ? 1 : 3, contentBudget);
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
		const visibleQuestionRows = questionBody.slice(view.getScrollOffset(), view.getScrollOffset() + questionHeight);
		this.#questionVisibleFor =
			questionHeight > 0 &&
			(requiresControlMarker
				? visibleQuestionRows.some(line => line.includes(CURSOR_MARKER))
				: formStart < view.getScrollOffset() + questionHeight)
				? entry
				: undefined;
		const notice = this.#retired ? " · question ended elsewhere; draft retained" : "";
		const main = [
			...(headerRows
				? [truncateToWidth(theme.fg("muted", heading), mainWidth), truncateToWidth(identity, mainWidth)]
				: []),
			...this.#transcriptView.render(mainWidth).slice(0, transcriptHeight),
			...(questionHeaderRows
				? [
						truncateToWidth(
							theme.fg("dim", `── ${inputFocused ? "question" : "question focused"}${notice} ──`),
							mainWidth,
						),
					]
				: []),
			...view.render(mainWidth).slice(0, questionHeight),
			...footer,
		].slice(-contentHeight);
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
