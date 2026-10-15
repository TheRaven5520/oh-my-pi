import { TUI, type Component } from "../../tui";
import { ScrollView } from "../../components/scroll-view";
import { matchesKey } from "../../keys";
import { AskDialogComponent, type AskDialogPrompt } from "../../overlays/ask-dialog";
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
import type { CentralAnswer, CentralSnapshot, CentralTuiHost } from "./types";

interface CentralForm {
	component: Component;
	view: ScrollView;
	prompt?: { component: HookEditorComponent; resolve: (value: string | undefined) => void };
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
	#transcriptChatId: string | undefined;
	#transcriptRevision: string | undefined;
	#transcriptBuilder: ChatTranscriptBuilder | undefined;
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
				this.#snapshot.chats.find(chat => chat.id === this.#selectedChatId) ??
				this.#snapshot.chats.find(chat => chat.id === this.#queue.current?.chat.id) ??
				this.#snapshot.chats[0];
			this.#selectedChatId = selected?.id;
			if (
				selected &&
				(selected.id !== this.#transcriptChatId || selected.transcriptRevision !== this.#transcriptRevision)
			)
				void this.#loadTranscript(selected.id, selected.cwd, selected.transcriptRevision);
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

	async #loadTranscript(chatId: string, cwd: string, revision?: string): Promise<void> {
		if (this.#transcriptLoading) return;
		const switchingChat = chatId !== this.#transcriptChatId;
		if (switchingChat) {
			this.#transcriptView.setFollowTail(true);
			this.#transcriptView.scrollToBottom();
		}
		this.#transcriptLoading = true;
		try {
			const entries = await this.host.transcript(chatId);
			if (this.#stopped || this.#selectedChatId !== chatId) return;
			const builder = new ChatTranscriptBuilder({ ui: this.ui, cwd, requestRender: () => this.ui.requestRender() });
			builder.rebuild(entries);
			this.#transcriptBuilder?.dispose();
			this.#transcriptBuilder = builder;
			this.#transcriptChatId = chatId;
			this.#transcriptRevision = revision;
		} catch {
			this.#transcriptBuilder = undefined;
			this.#transcriptChatId = chatId;
			this.#transcriptRevision = revision;
		} finally {
			this.#transcriptLoading = false;
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
					onCancel: () => this.#queue.skip(),
					onPrompt: (prompt, prefill) => this.#prompt(entry, prompt, prefill),
				},
				{ tui: this.ui },
			);
		} else if (request.kind === "select") {
			component = new HookSelectorComponent(request.title, request.options, submit, () => this.#queue.skip(), {
				tui: this.ui,
				initialIndex: request.initialIndex,
				selectionMarker: request.selectionMarker,
				checkedIndices: request.checkedIndices,
				markableCount: request.markableCount,
				disabledIndices: request.disabledIndices,
				maxVisible: Math.max(3, this.ui.terminal.rows - 14),
			});
		} else {
			component = new HookEditorComponent(
				this.ui,
				request.title,
				request.prefill,
				submit,
				() => this.#queue.skip(),
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
		prefill?: string,
	): Promise<string | undefined> {
		if (this.#stopped || !this.#queue.has(entry)) return Promise.resolve(undefined);
		const form = entry.draft!;
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const finish = (value: string | undefined): void => {
			form.prompt?.component.dispose();
			form.prompt = undefined;
			form.view.setScrollOffset(0);
			resolve(value);
			if (!this.#stopped) this.ui.requestRender();
		};
		form.prompt = {
			component: new HookEditorComponent(this.ui, prompt.title, prefill, finish, () => finish(undefined), {
				promptStyle: true,
				question: prompt.question,
				maxHeight: Math.max(3, this.ui.terminal.rows - 16),
			}),
			resolve: finish,
		};
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
		} catch (error) {
			if (this.#stopped) return;
			form.error = `Answer not accepted: ${sanitizeDisplayLine(String(error))}. Enter retries the saved answer; F7 opens the chat.`;
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
		const chats = this.#snapshot.chats;
		if (chats.length === 0) return;
		const current = Math.max(
			0,
			chats.findIndex(chat => chat.id === this.#selectedChatId),
		);
		const next = chats[(current + direction + chats.length) % chats.length]!;
		this.#selectedChatId = next.id;
		void this.#loadTranscript(next.id, next.cwd, next.transcriptRevision);
		this.ui.requestRender();
	}

	handleInput(data: string): void {
		if (
			data.startsWith("\x1b[<") &&
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					const entry = this.#showRetired ? this.#retired : this.#queue.current;
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
		const entry = this.#queue.current;
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
			if (!form?.sending) this.#queue.skip();
		} else if (form && !form.sending) {
			if (form.answer !== undefined) {
				if (matchesKey(data, "enter")) void this.#send(entry!);
			} else {
				form.touched = true;
				form.component.handleInput?.(data);
			}
		}
		this.ui.requestRender();
	}

	render(width: number): readonly string[] {
		const height = Math.max(1, this.ui.terminal.rows);
		const sidebarWidth = width >= 80 ? Math.min(32, Math.max(26, Math.floor(width * 0.28))) : 0;
		const mainWidth = Math.max(1, width - (sidebarWidth > 0 ? sidebarWidth + 3 : 0));
		const entry = this.#showRetired ? this.#retired : this.#queue.current;
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
		const transcriptRows = this.#transcriptBuilder?.container.render(Math.max(1, mainWidth - 2)) ?? [];
		const footerRows = 3;
		const questionHeight = Math.min(questionBody.length + 1, Math.max(0, height - footerRows - 3));
		const transcriptHeight = Math.max(0, height - footerRows - questionHeight - 3);
		this.#questionTop = 2 + transcriptHeight + (questionBody.length > 0 ? 1 : 0);
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
		].slice(0, height);
		if (sidebarWidth === 0) return main;
		const roster = [
			theme.bold(theme.fg("accent", `CHATS · ${this.#snapshot.chats.length} active`)),
			...this.#snapshot.chats.flatMap(chat => [
				`${chat.id === this.#selectedChatId ? "❯" : " "} ${chat.busy ? "●" : "○"} ${sanitizeDisplayLine(chat.name) || "Untitled chat"}`,
				`  ${chat.requests.length ? `${chat.requests.length} question${chat.requests.length === 1 ? "" : "s"} waiting` : "no question"}`,
			]),
		];
		return Array.from({ length: height }, (_, index) => {
			const left = main[index] ?? "";
			const padded = left + " ".repeat(Math.max(0, mainWidth - visibleWidth(left)));
			return `${padded} ${theme.fg("dim", "│")} ${truncateToWidth(roster[index] ?? "", sidebarWidth)}`;
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
