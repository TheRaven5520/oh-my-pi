import type { ImageContent } from "@oh-my-pi/pi-ai";
import type {
	CentralAnswer,
	CentralChat,
	CentralCommandInfo,
	CentralRequest,
	CentralRequestDraft,
	CentralWorkspace,
} from "@oh-my-pi/pi-tui/apps/central/types";
import type { ExtensionAskDialogResultItem } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { sanitizeDisplayLine, sanitizeDisplaySgrLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { isBuiltinComposerStyle } from "@oh-my-pi/pi-tui/components/composer/registry";

export const CENTRAL_MAX_PROMPT_BYTES = 64 * 1024;
export const CENTRAL_MAX_WORKSPACE_WIDTH = 1_000;
export const CENTRAL_MAX_COMMANDS = 600;
export const CENTRAL_MAX_COMMAND_RESULT_BYTES = 16 * 1024;

export function isCentralWorkspaceWidth(value: unknown): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= CENTRAL_MAX_WORKSPACE_WIDTH
	);
}

export function isCentralPrompt(sessionId: unknown, requestId: unknown, text: unknown): boolean {
	return (
		typeof sessionId === "string" &&
		sessionId.length > 0 &&
		sessionId.length <= 256 &&
		typeof requestId === "string" &&
		/^[A-Za-z0-9_-]{1,128}$/.test(requestId) &&
		typeof text === "string" &&
		text.trim().length > 0 &&
		Buffer.byteLength(text) <= CENTRAL_MAX_PROMPT_BYTES
	);
}

/** A `command` op carries one slash command: prompt limits, and it must start with `/`. */
export function isCentralCommand(sessionId: unknown, requestId: unknown, text: unknown): boolean {
	return isCentralPrompt(sessionId, requestId, text) && /^\/[^\s/]/.test(text as string);
}

/** What a chat reported for a command: plain text, capped; never terminal control data. */
export function parseCentralCommandResult(value: unknown): string | null {
	if (typeof value !== "string" || Buffer.byteLength(value) > CENTRAL_MAX_COMMAND_RESULT_BYTES) return null;
	return value
		.split("\n")
		.map(line => sanitizeDisplayLine(line))
		.join("\n");
}

/** Completion metadata only; malformed entries are dropped, the list is capped. */
function parseCentralCommands(value: unknown): CentralCommandInfo[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const commands: CentralCommandInfo[] = [];
	for (const item of value.slice(0, CENTRAL_MAX_COMMANDS)) {
		if (!record(item) || typeof item.name !== "string" || !/^[^\s/][^\s]{0,127}$/.test(item.name)) continue;
		if (sanitizeDisplayLine(item.name) !== item.name) continue;
		const command: CentralCommandInfo = { name: item.name };
		if (strings(item.aliases)) {
			const aliases = item.aliases
				.slice(0, 8)
				.filter(alias => /^[^\s/][^\s]{0,127}$/.test(alias) && sanitizeDisplayLine(alias) === alias);
			if (aliases.length > 0) command.aliases = aliases;
		}
		if (typeof item.description === "string" && item.description)
			command.description = sanitizeDisplayLine(item.description.slice(0, 300));
		if (typeof item.argumentHint === "string" && item.argumentHint)
			command.argumentHint = sanitizeDisplayLine(item.argumentHint.slice(0, 80));
		commands.push(command);
	}
	return commands;
}

/** Only SGR may survive the host boundary; all other terminal control data is inert. */
export function parseCentralWorkspace(
	value: unknown,
	statusWidth: number,
	usageWidth: number,
): CentralWorkspace | null {
	if (!record(value) || typeof value.canPrompt !== "boolean") return null;
	const lines = (input: unknown, width: number, maxRows: number): string[] | null => {
		if (!strings(input) || input.length > maxRows || input.some(line => Buffer.byteLength(line) > 64 * 1024))
			return null;
		return input.map(line => {
			const safe = sanitizeDisplaySgrLine(line);
			return width === 0 ? "" : `${truncateToWidth(safe, width)}\x1b[0m`;
		});
	};
	const statusLines = lines(value.statusLines, statusWidth, 16);
	const usageLines = lines(value.usageLines, usageWidth, 64);
	if (!statusLines || !usageLines) return null;
	const workspace: CentralWorkspace = { statusLines, usageLines, canPrompt: value.canPrompt };
	if (value.canCommand === true) workspace.canCommand = true;
	const commands = parseCentralCommands(value.commands);
	if (commands) workspace.commands = commands;
	if (typeof value.promptUnavailableReason === "string")
		workspace.promptUnavailableReason = sanitizeDisplaySgrLine(value.promptUnavailableReason.slice(0, 1024));
	if (
		record(value.composer) &&
		typeof value.composer.shape === "string" &&
		isBuiltinComposerStyle(value.composer.shape)
	) {
		const border = value.composer.topBorder;
		if (
			record(border) &&
			typeof border.content === "string" &&
			typeof border.width === "number" &&
			Number.isFinite(border.width)
		) {
			const content = lines([border.content], statusWidth, 1);
			const title = border.title === undefined ? [] : lines([border.title], statusWidth, 1);
			if (!content || !title) return null;
			workspace.composer = {
				shape: value.composer.shape,
				topBorder: {
					content: content[0]!,
					width: Math.max(0, Math.min(statusWidth, border.width)),
					title: title[0],
				},
			};
		}
	}
	return workspace;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function optionalInteger(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function sameStrings(value: unknown, expected: string[]): value is string[] {
	return strings(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function indices(value: unknown, count: number): value is number[] | undefined {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.every(index => typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < count))
	);
}

export function isCentralRequestDraft(value: unknown): value is CentralRequestDraft {
	if (!record(value)) return false;
	if (value.kind === "editor") return typeof value.title === "string" && optionalString(value.prefill);
	if (value.kind === "select") {
		return (
			typeof value.title === "string" &&
			Array.isArray(value.options) &&
			value.options.every(
				option =>
					typeof option === "string" ||
					(record(option) && typeof option.label === "string" && optionalString(option.description)),
			) &&
			optionalInteger(value.initialIndex) &&
			optionalInteger(value.markableCount) &&
			(value.selectionMarker === undefined ||
				value.selectionMarker === "radio" ||
				value.selectionMarker === "checkbox") &&
			indices(value.checkedIndices, value.options.length) &&
			indices(value.disabledIndices, value.options.length)
		);
	}
	return (
		value.kind === "ask" &&
		Array.isArray(value.questions) &&
		value.questions.every(
			question =>
				record(question) &&
				typeof question.id === "string" &&
				typeof question.question === "string" &&
				optionalString(question.header) &&
				(question.multi === undefined || typeof question.multi === "boolean") &&
				optionalInteger(question.recommended) &&
				Array.isArray(question.options) &&
				question.options.every(
					option =>
						record(option) &&
						typeof option.label === "string" &&
						optionalString(option.description) &&
						optionalString(option.preview),
				),
		)
	);
}

/** Validate every nested question before a local or SSH snapshot reaches the TUI. */
export function parseCentralChat(value: unknown): CentralChat | null {
	if (
		!record(value) ||
		typeof value.id !== "string" ||
		!value.id ||
		typeof value.sessionId !== "string" ||
		typeof value.pid !== "number" ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		typeof value.name !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.busy !== "boolean" ||
		!optionalString(value.source) ||
		!Array.isArray(value.requests)
	)
		return null;
	if (
		value.location !== undefined &&
		(!record(value.location) || typeof value.location.socket !== "string" || typeof value.location.pane !== "string")
	)
		return null;
	const ids = new Set<string>();
	for (const request of value.requests) {
		if (!record(request) || !isCentralRequestDraft(request)) return null;
		const full = request as CentralRequest;
		if (
			typeof full.id !== "string" ||
			!full.id ||
			typeof full.createdAt !== "number" ||
			!Number.isFinite(full.createdAt) ||
			ids.has(full.id)
		)
			return null;
		ids.add(full.id);
	}
	return value as unknown as CentralChat;
}

function images(value: unknown): value is ImageContent[] | undefined {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.every(
				image =>
					record(image) &&
					image.type === "image" &&
					typeof image.data === "string" &&
					/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) &&
					typeof image.mimeType === "string" &&
					/^image\/[a-zA-Z0-9.+-]+$/.test(image.mimeType) &&
					(image.detail === undefined || ["auto", "low", "high", "original"].includes(String(image.detail))) &&
					Object.keys(image).every(key => ["type", "data", "mimeType", "detail"].includes(key)),
			))
	);
}

/** Correlation metadata is checked then rebuilt from the pending request, never trusted. */
export function validateCentralAnswer(request: CentralRequest, value: unknown): CentralAnswer | undefined {
	if (request.kind === "editor") return typeof value === "string" ? value : undefined;
	if (request.kind === "select") {
		return typeof value === "string" &&
			request.options.some(
				(option, index) =>
					(typeof option === "string" ? option : option.label) === value &&
					!request.disabledIndices?.includes(index),
			)
			? value
			: undefined;
	}
	if (!record(value)) return undefined;
	if (value.kind === "chat") return Object.keys(value).length === 1 ? { kind: "chat" } : undefined;
	if (
		value.kind !== "submit" ||
		!Array.isArray(value.results) ||
		value.results.length !== request.questions.length ||
		Object.keys(value).some(key => key !== "kind" && key !== "results")
	)
		return undefined;
	const results: ExtensionAskDialogResultItem[] = [];
	for (const [index, question] of request.questions.entries()) {
		const answer: unknown = value.results[index];
		const options = question.options.map(option => option.label);
		if (
			!record(answer) ||
			answer.id !== question.id ||
			answer.question !== question.question ||
			!sameStrings(answer.options, options) ||
			answer.multi !== (question.multi ?? false) ||
			!strings(answer.selectedOptions) ||
			!optionalString(answer.customInput) ||
			!optionalString(answer.note) ||
			!images(answer.customInputImages) ||
			!images(answer.noteImages) ||
			(answer.timedOut !== undefined && answer.timedOut !== false) ||
			Object.keys(answer).some(
				key =>
					![
						"id",
						"question",
						"options",
						"multi",
						"selectedOptions",
						"customInput",
						"customInputImages",
						"note",
						"noteImages",
						"timedOut",
					].includes(key),
			)
		)
			return undefined;
		const selected = new Set(answer.selectedOptions);
		if (
			!sameStrings(
				answer.selectedOptions,
				options.filter(option => selected.has(option)),
			) ||
			(!question.multi && (selected.size > 1 || (selected.size > 0 && answer.customInput !== undefined))) ||
			(answer.customInputImages !== undefined && answer.customInput === undefined) ||
			(answer.noteImages !== undefined && answer.note === undefined)
		)
			return undefined;
		results.push({
			id: question.id,
			question: question.question,
			options,
			multi: question.multi ?? false,
			selectedOptions: [...answer.selectedOptions],
			customInput: answer.customInput as string | undefined,
			customInputImages: answer.customInputImages,
			note: answer.note as string | undefined,
			noteImages: answer.noteImages,
		});
	}
	return { kind: "submit", results };
}
