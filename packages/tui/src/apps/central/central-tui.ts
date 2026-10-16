import { TUI, type Component } from "../../tui";
import { ScrollView } from "../../components/scroll-view";
import { matchesKey } from "../../keys";
import { getKeybindings } from "../../keybindings";
import { getDefaultPasteImageKeys } from "../../app-keybindings";
import { AskDialogComponent, type AskDialogPrompt, type AskDialogPromptValue } from "../../overlays/ask-dialog";
import { sanitizeDisplayLine, sanitizeDisplayText } from "../../overlays/extensions/display-text";
import { HookEditorComponent } from "../../overlays/hook-editor";
import { HookSelectorComponent } from "../../overlays/hook-selector";
import { wrapTextWithAnsi } from "../../render/render-utils";
import { ChatTranscriptBuilder } from "../../chat/chat-transcript-builder";
import { routeSgrMouseInput } from "../../mouse";
import { ProcessTerminal } from "../../terminal";
import { theme } from "../../theme/theme";
import { truncateToWidth, visibleWidth } from "../../utils";
import { CentralQueue, type CentralQueueEntry } from "./queue";
import type { CentralAnswer, CentralChat, CentralSnapshot, CentralTuiHost } from "./types";

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

/** One quiet inbox; all answer state stays attached to its original request. */
export class CentralComponent implements Component {
	readonly #queue = new CentralQueue<CentralForm>();
	readonly #emptyView = new ScrollView([], { height: 1 });
	readonly #finished = Promise.withResolvers<void>();
	#snapshot: CentralSnapshot = { chats: [], errors: [] };
	#timer: NodeJS.Timeout | undefined;
	#stopped = false;
	#loaded = false;
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
	#focus: "roster" | "main" = "main";
	#questionTop = 0;
	#transcriptView = new ScrollView([], { height: 1, followTail: true, scrollbar: "auto" });

	constructor(
		readonly ui: TUI,
		readonly host: CentralTuiHost,
	) {}

	async run(): Promise<void> {
		void this.#refresh();
		await this.#finished.promise;
	}

	async #refresh(): Promise<void> {
		try {
			const snapshot = await this.host.refresh();
			if (this.#stopped) return;
			this.#snapshot = snapshot;
			for (const entry of this.#queue.update(snapshot.chats)) {
				if (entry.draft?.touched && entry.draft.answer === undefined) {
					if (this.#retired?.draft) this.#disposeForm(this.#retired.draft);
					this.#retired = entry;
					this.#showRetired = false;
				} else if (entry.draft) this.#disposeForm(entry.draft);
			}
			const selected =
				(this.#manualSelection ? this.#snapshot.chats.find(chat => chat.id === this.#selectedChatId) : undefined) ??
				this.#snapshot.chats.find(chat => chat.id === this.#queue.current?.chat.id) ??
				this.#snapshot.chats[0];
			if (!selected) {
				this.#selectedChatId = undefined;
			} else {
				this.#selectedChatId = selected.id;
				if (selected.id !== this.#transcriptChatId || selected.transcriptRevision !== this.#transcriptRevision)
					void this.#loadTranscript(selected.id, selected.cwd, selected.transcriptRevision);
			}
		} catch (error) {
			if (this.#stopped) return;
			this.#snapshot = {
				...this.#snapshot,
				errors: [`Cannot refresh chats: ${sanitizeDisplayLine(String(error))}. Retrying automatically.`],
			};
		} finally {
			if (!this.#stopped) {
				this.#loaded = true;
				this.ui.requestRender();
				// Schedule after completion: slow sources never overlap another poll.
				this.#timer = setTimeout(() => void this.#refresh(), 1000);
			}
		}
	}

	#entryForSelectedChat(): CentralQueueEntry<CentralForm> | undefined {
		return this.#selectedChatId ? this.#queue.entryForChat(this.#selectedChatId) : this.#queue.current;
	}

	#followQueueCurrent(): void {
		this.#manualSelection = false;
		const next = this.#queue.current;
		const selected = next?.chat ?? this.#snapshot.chats[0];
		this.#selectedChatId = selected?.id;
		if (selected) void this.#loadTranscript(selected.id, selected.cwd, selected.transcriptRevision);
		this.ui.requestRender();
	}
	#skipChat(chatId: string): void {
		this.#queue.skip(chatId);
		this.#followQueueCurrent();
	}

	#selectChat(chatId: string, manual: boolean): void {
		const chat = this.#snapshot.chats.find(candidate => candidate.id === chatId);
		if (!chat) return;
		this.#manualSelection = manual;
		this.#selectedChatId = chatId;
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
		if (switchingChat) {
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
			builder.rebuild(entries);
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
				{ tui: this.ui },
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

	async #open(entry: CentralQueueEntry<CentralForm>): Promise<void> {
		if (this.#opening) return;
		this.#opening = true;
		this.#openError = undefined;
		try {
			await this.host.open(entry.chat.id);
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
				}
				return true;
			})
		)
			return;
		if (matchesKey(data, "ctrl+c")) {
			this.#finished.resolve();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.#focus = this.#focus === "main" ? "roster" : "main";
			this.ui.requestRender();
			return;
		}
		if (this.#focus === "roster" && (matchesKey(data, "up") || matchesKey(data, "down"))) {
			this.#selectAdjacent(matchesKey(data, "up") ? -1 : 1);
			return;
		}
		const entry = this.#entryForSelectedChat();
		const form = entry ? this.#form(entry) : undefined;
		if (matchesKey(data, "ctrl+o") && entry) {
			void this.#open(entry);
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
		const sidebarWidth = width >= 80 ? Math.min(32, Math.max(26, Math.floor(width * 0.28))) : 0;
		const mainWidth = Math.max(1, width - (sidebarWidth > 0 ? sidebarWidth + 3 : 0));
		const compactRosterRows = sidebarWidth === 0 ? 2 : 0;
		const contentHeight = Math.max(1, height - compactRosterRows);
		const entry = this.#showRetired ? this.#retired : this.#entryForSelectedChat();
		const form = entry ? this.#form(entry) : undefined;
		const busyCount = this.#snapshot.chats.filter(chat => chat.busy).length;
		const heading = `OMP Central  ·  ${this.#snapshot.chats.length} active  ·  ${this.#queue.chatCount} waiting  ·  ${busyCount} busy`;
		const selectedChat = this.#snapshot.chats.find(chat => chat.id === this.#selectedChatId);
		const identity = selectedChat
			? `${sanitizeDisplayLine(selectedChat.name) || "Untitled chat"}  ·  ${sanitizeDisplayLine(selectedChat.source ?? "local")}  ·  ${sanitizeDisplayLine(selectedChat.cwd)}`
			: `${this.#snapshot.chats.length} active chats`;
		const body: string[] = [];
		for (const error of this.#snapshot.errors) {
			body.push(...wrapTextWithAnsi(theme.fg("error", sanitizeDisplayText(error)), Math.max(1, mainWidth - 2)));
		}
		if (this.#openError)
			body.push(...wrapTextWithAnsi(theme.fg("error", this.#openError), Math.max(1, mainWidth - 2)));
		if (this.#transcriptError)
			body.push(...wrapTextWithAnsi(theme.fg("error", this.#transcriptError), Math.max(1, mainWidth - 2)));
		if (form) {
			if (form.error) body.push(...wrapTextWithAnsi(theme.fg("error", form.error), Math.max(1, mainWidth - 2)));
			if (form.sending) body.push(theme.fg("muted", "Sending answer…"));
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
				if ("focused" in component) component.focused = this.focused && !this.#showRetired && !form.sending;
				body.push(...component.render(Math.max(1, mainWidth - 2)));
			}
		} else {
			body.push(
				theme.fg(
					"muted",
					!this.#loaded
						? "Looking for questions…"
						: this.#snapshot.errors.length
							? "Some chats are unavailable; questions may be missing."
							: "No questions waiting",
				),
			);
		}
		const questionBody = body;
		const transcriptRows =
			this.#transcriptLoading && !this.#transcriptBuilder
				? [theme.fg("muted", "Loading chat transcript…")]
				: (this.#transcriptBuilder?.container.render(Math.max(1, mainWidth - 2)) ?? []);
		const footerRows = 3;
		const contentBudget = Math.max(0, contentHeight - footerRows - 3);
		const minimumTranscriptHeight = contentBudget === 0 ? 0 : Math.min(8, Math.max(3, Math.floor(contentBudget / 3)));
		const questionHeight = Math.min(questionBody.length + 1, Math.max(0, contentBudget - minimumTranscriptHeight));
		const transcriptHeight = Math.max(minimumTranscriptHeight, contentHeight - footerRows - questionHeight - 3);
		this.#questionTop = compactRosterRows + 2 + transcriptHeight + (questionBody.length > 0 ? 1 : 0);
		this.#transcriptView.setHeight(transcriptHeight);
		this.#transcriptView.setLines(transcriptRows);
		const view = form?.view ?? this.#emptyView;
		view.setHeight(questionHeight);
		view.setLines(questionBody);
		const notice = this.#showRetired
			? "Unsent draft · question ended in original chat"
			: this.#retired
				? "Question ended elsewhere; draft not sent"
				: "";
		const main = [
			truncateToWidth(theme.fg("muted", heading), mainWidth),
			truncateToWidth(identity, mainWidth),
			...this.#transcriptView.render(mainWidth),
			...(questionBody.length > 0 ? [truncateToWidth(theme.fg("dim", "── current question ──"), mainWidth)] : []),
			...view.render(mainWidth),
			truncateToWidth(theme.fg("muted", notice), mainWidth),
			truncateToWidth(
				theme.fg("dim", "Tab chats · ↑/↓ select or scroll · wheel scroll · Ctrl+O open · Ctrl+C close"),
				mainWidth,
			),
		].slice(0, contentHeight);
		const roster = this.#rosterLines(height, sidebarWidth);
		if (sidebarWidth === 0) return [...this.#compactRoster(width), ...main].slice(0, height);
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
		this.#finished.resolve();
	}
}

/** Close only this fullscreen inbox; no cancellation is sent to a chat. */
export async function runCentralTui(host: CentralTuiHost): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const component = new CentralComponent(ui, host);
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
		await component.run();
	} finally {
		component.dispose();
		overlay.hide();
		ui.stop();
	}
}
