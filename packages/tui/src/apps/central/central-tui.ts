import { matchesAppInterrupt, matchesSelectCancel } from "../../keybinding-matchers";
import { ScrollView } from "../../components/scroll-view";
import { matchesKey } from "../../keys";
import { AskDialogComponent, type AskDialogPrompt } from "../../overlays/ask-dialog";
import { sanitizeDisplayLine, sanitizeDisplayText } from "../../overlays/extensions/display-text";
import { HookEditorComponent } from "../../overlays/hook-editor";
import { HookSelectorComponent } from "../../overlays/hook-selector";
import { wrapTextWithAnsi } from "../../render/render-utils";
import { ProcessTerminal } from "../../terminal";
import { theme } from "../../theme/theme";
import { type Component, TUI } from "../../tui";
import { truncateToWidth } from "../../utils";
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
class CentralComponent implements Component {
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

	handleInput(data: string): void {
		// Must precede the nested editor: Ctrl+C there means cancel/clear, not quit.
		if (matchesKey(data, "ctrl+c")) {
			this.#finished.resolve();
			return;
		}
		if (matchesKey(data, "f8") && this.#retired) {
			this.#showRetired = !this.#showRetired;
			this.ui.requestRender();
			return;
		}
		const entry = this.#showRetired ? this.#retired : this.#queue.current;
		if (matchesKey(data, "f7") && entry) {
			void this.#open(entry);
			return;
		}
		const form = entry ? this.#form(entry) : undefined;
		if (matchesKey(data, "f4") && form) {
			form.details = !form.details;
			form.view.setScrollOffset(0);
		} else if (
			matchesKey(data, "f6") ||
			(!form?.prompt &&
				(matchesKey(data, "escape") ||
					(entry?.request.kind === "editor" ? matchesAppInterrupt(data) : matchesSelectCancel(data))))
		) {
			if (!form?.sending) {
				if (!this.#showRetired) this.#queue.skip();
				this.#showRetired = false;
				this.#openError = undefined;
			}
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			const view = form?.view ?? this.#emptyView;
			if (
				form &&
				!form.details &&
				!this.#showRetired &&
				!form.sending &&
				form.answer === undefined &&
				view.getMaxScrollOffset() === 0
			) {
				(form.prompt?.component ?? form.component).handleInput?.(data);
			} else view.scroll((matchesKey(data, "pageUp") ? -1 : 1) * Math.max(1, this.ui.terminal.rows - 6));
		} else if (form && !form.details && !this.#showRetired && !form.sending) {
			if (form.answer !== undefined) {
				if (matchesKey(data, "enter") && entry) void this.#send(entry);
			} else {
				form.touched = true;
				(form.prompt?.component ?? form.component).handleInput?.(data);
			}
		}
		this.ui.requestRender();
	}

	render(width: number): readonly string[] {
		const height = Math.max(1, this.ui.terminal.rows);
		const entry = this.#showRetired ? this.#retired : this.#queue.current;
		const form = entry ? this.#form(entry) : undefined;
		const heading = `OMP Central${this.#queue.chatCount ? `  ·  ${this.#queue.chatCount} waiting` : ""}`;
		const identity = entry
			? `${sanitizeDisplayLine(entry.chat.name) || "Untitled chat"}  ·  ${sanitizeDisplayLine(entry.chat.source ?? "local")}`
			: `${this.#snapshot.chats.length} active chats`;
		const body: string[] = [];
		for (const error of this.#snapshot.errors) {
			body.push(...wrapTextWithAnsi(theme.fg("error", sanitizeDisplayText(error)), Math.max(1, width - 1)));
		}
		if (this.#openError) body.push(...wrapTextWithAnsi(theme.fg("error", this.#openError), Math.max(1, width - 1)));
		if (form) {
			if (form.error) body.push(...wrapTextWithAnsi(theme.fg("error", form.error), Math.max(1, width - 1)));
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
				body.push(...wrapTextWithAnsi(sanitizeDisplayText(text), Math.max(1, width - 1)));
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
				body.push(...wrapTextWithAnsi(sanitizeDisplayText(text), Math.max(1, width - 1)));
			} else {
				const component = form.prompt?.component ?? form.component;
				if ("focused" in component) component.focused = this.focused && !this.#showRetired && !form.sending;
				body.push(...component.render(Math.max(1, width - 1)));
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
		const view = form?.view ?? this.#emptyView;
		view.setHeight(Math.max(0, height - 4));
		view.setLines(body);
		const notice = this.#showRetired
			? "Unsent draft · question ended in original chat · F8 returns"
			: this.#retired
				? "Question ended elsewhere; draft not sent · F8 view draft"
				: "";
		return [
			truncateToWidth(theme.fg("muted", heading), width),
			truncateToWidth(identity, width),
			...view.render(width),
			truncateToWidth(theme.fg("muted", notice), width),
			truncateToWidth(theme.fg("dim", "F6 Skip · F7 Open · F4 Question · PgUp/PgDn scroll · Ctrl+C close"), width),
		].slice(0, height);
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
		mouseTracking: false,
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
