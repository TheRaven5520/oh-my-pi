import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "../../autocomplete";
import type { TranscriptEntryLike } from "../../chat/transcript-entry";
import { Markdown } from "../../components/markdown";
import { sanitizeDisplayLine } from "../../overlays/extensions/display-text";
import { clockDateTimeFormat } from "../../render/clock";
import { wrapTextWithAnsi } from "../../render/render-utils";
import { getMarkdownTheme, theme } from "../../theme/theme";
import { truncateToWidth } from "../../utils";
import type { CentralChat, CentralCommandInfo, CentralSnapshot } from "./types";

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Only assistant reply text: no user, tool, custom or system messages, and no
 * thinking, tool calls, usage, or error chrome inside an assistant message.
 */
export function focusTranscriptEntries(entries: readonly TranscriptEntryLike[]): TranscriptEntryLike[] {
	const replies: TranscriptEntryLike[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		if (!Array.isArray(message.content)) continue;
		const content = message.content.filter(
			(block): block is TextContent =>
				block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
		);
		if (content.length === 0) continue;
		replies.push({
			...entry,
			message: {
				role: "assistant",
				content,
				api: message.api,
				provider: message.provider,
				model: message.model,
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: message.timestamp,
			},
		});
	}
	return replies;
}

/**
 * A focus-local event in the conversation flow, at the time it happened: a
 * command run from the focus composer, or a question that ended elsewhere. It
 * lives only in this focus view (never in the chat's transcript, never sent),
 * so a restart of the view drops it.
 */
export interface CentralFocusNotice {
	kind: "notice";
	id: string;
	at: number;
	/** Header text after the time, e.g. `/tan · ran in the chat`. */
	title: string;
	/** Body rows (command output), already capped. */
	lines: readonly string[];
	/** Source lines left out by the cap. */
	more: number;
}

/** Text of one assistant message within a reply, with that message's time. */
export interface CentralFocusReplyPart {
	at: number | undefined;
	text: string;
}

/** One turn of the focused conversation: a reply, a message sent from the focus composer, or a focus notice. */
export type CentralFocusTurn =
	/** `text` is every part joined; `parts` lets a notice split the reply where it happened. */
	| { kind: "reply"; id: string; at: number | undefined; text: string; parts: CentralFocusReplyPart[] }
	| { kind: "sent"; id: string; at: number | undefined; text: string; queued?: boolean }
	| CentralFocusNotice;

/**
 * Notices (oldest first) in time order among the turns: each goes before the
 * first turn or reply part stamped after it, so whatever the chat wrote later
 * renders below it. A notice that lands inside a reply splits it there, and the
 * rest of the reply continues below under its own time. Turns and parts without
 * a time keep their place, and notices newer than everything go last.
 */
export function mergeFocusNotices(
	turns: readonly CentralFocusTurn[],
	notices: readonly CentralFocusNotice[],
): CentralFocusTurn[] {
	if (notices.length === 0) return [...turns];
	const merged: CentralFocusTurn[] = [];
	let next = 0;
	const flush = (at: number | undefined): boolean => {
		const before = next;
		while (next < notices.length && at !== undefined && notices[next]!.at < at) merged.push(notices[next++]!);
		return next !== before;
	};
	for (const turn of turns) {
		if (turn.kind !== "reply") {
			flush(turn.at);
			merged.push(turn);
			continue;
		}
		let segment: Extract<CentralFocusTurn, { kind: "reply" }> | undefined;
		turn.parts.forEach((part, index) => {
			if (flush(part.at) || !segment) {
				const id = index === 0 ? turn.id : `${turn.id}:${index}`;
				segment = { kind: "reply", id, at: part.at, text: part.text, parts: [part] };
				merged.push(segment);
			} else {
				segment.text += `\n\n${part.text}`;
				segment.parts.push(part);
			}
		});
	}
	for (; next < notices.length; next++) merged.push(notices[next]!);
	return merged;
}

function entryTime(entry: TranscriptEntryLike): number | undefined {
	const raw = entry.type === "message" ? entry.message.timestamp : undefined;
	const fromMessage = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
	const fromEntry = Date.parse(entry.timestamp);
	return fromMessage ?? (Number.isFinite(fromEntry) && fromEntry > 0 ? fromEntry : undefined);
}

function userText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts = content.filter(
		(block): block is TextContent => block?.type === "text" && typeof block.text === "string",
	);
	return parts.length > 0 ? parts.map(part => part.text).join("\n") : undefined;
}

/**
 * The conversation as turns. One reply is the text of every assistant message
 * between two user messages, so a reply split by hidden tool calls stays one
 * turn, timed by its first text; its `parts` keep each message's own time. A
 * user message beginning with the focus `prefix` is a sent turn (shown without
 * it). Other user messages end the current reply but are not shown; tool
 * results and custom messages are omitted.
 */
export function focusTurns(entries: readonly TranscriptEntryLike[], prefix: string): CentralFocusTurn[] {
	const turns: CentralFocusTurn[] = [];
	const replies = new Map(focusTranscriptEntries(entries).map(entry => [entry.id, entry]));
	let open: Extract<CentralFocusTurn, { kind: "reply" }> | undefined;
	for (const entry of entries) {
		const reply = replies.get(entry.id);
		if (reply?.type === "message" && reply.message.role === "assistant") {
			const text = (reply.message.content as TextContent[]).map(block => block.text).join("\n\n");
			const part = { at: entryTime(entry), text };
			if (open) {
				open.text += `\n\n${text}`;
				open.parts.push(part);
			} else {
				open = { kind: "reply", id: entry.id, at: part.at, text, parts: [part] };
				turns.push(open);
			}
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		open = undefined;
		const text = prefix ? userText(entry.message.content) : undefined;
		if (text?.startsWith(prefix))
			turns.push({ kind: "sent", id: entry.id, at: entryTime(entry), text: text.slice(prefix.length) });
	}
	return turns;
}

/** `10:38 PM` in the configured display time zone, with a plain space before AM/PM. */
export function focusTurnTime(at: number | undefined): string {
	if (at === undefined) return "time unknown";
	return clockDateTimeFormat({ hour: "numeric", minute: "2-digit", hour12: true }).format(at).replace(/\s/g, " ");
}

/**
 * Each reply under a `── 10:38 PM ──` divider, rendered as Markdown; each sent
 * message as a dimmed `you:` line; each notice as a dimmed `── 10:40 PM · … ──`
 * header followed by its output rows. A `…working` line follows while the chat is busy.
 */
export function renderFocusTurns(turns: readonly CentralFocusTurn[], width: number, busy: boolean): string[] {
	const rows: string[] = [];
	const mdTheme = getMarkdownTheme();
	for (const turn of turns) {
		if (turn.kind === "notice") {
			if (rows.length > 0) rows.push("");
			const header = `── ${focusTurnTime(turn.at)} · ${sanitizeDisplayLine(turn.title)} ──`;
			rows.push(...wrapTextWithAnsi(header, Math.max(1, width)).map(line => theme.fg("dim", line)));
			for (const line of turn.lines)
				rows.push(...wrapTextWithAnsi(sanitizeDisplayLine(line), Math.max(1, width - 2)));
			if (turn.more > 0) rows.push(theme.fg("dim", `… ${turn.more} more line${turn.more === 1 ? "" : "s"}`));
			continue;
		}
		if (turn.kind === "sent") {
			const lines = wrapTextWithAnsi(
				`you: ${sanitizeDisplayLine(turn.text.replace(/\s*\n\s*/g, " "))}${turn.queued ? "  (queued)" : ""}`,
				Math.max(1, width - 2),
			);
			if (rows.length > 0) rows.push("");
			rows.push(...lines.map(line => theme.fg("dim", `  ${line}`)));
			continue;
		}
		const label = ` ${focusTurnTime(turn.at)} `;
		const side = Math.max(2, Math.floor((width - label.length) / 2));
		if (rows.length > 0) rows.push("");
		rows.push(truncateToWidth(theme.fg("dim", `${"─".repeat(side)}${label}${"─".repeat(side)}`), width));
		rows.push(...new Markdown(turn.text, 1, 0, mdTheme).render(Math.max(1, width)));
	}
	if (busy) rows.push("", theme.fg("dim", "  …working"));
	return rows;
}

/** What identifies the focused chat across restarts: its session first, then its name. */
export interface CentralFocusMemory {
	sessionId?: string;
	name?: string;
}

export type CentralFocusResolution =
	| { kind: "found"; chat: CentralChat }
	| { kind: "missing"; message: string }
	| { kind: "ambiguous"; message: string };

function byName(chats: readonly CentralChat[], name: string): CentralChat[] {
	const exact = chats.filter(chat => chat.name === name);
	if (exact.length > 0) return exact;
	const folded = name.toLowerCase();
	return chats.filter(chat => chat.name.toLowerCase() === folded);
}

/**
 * Resolve the target on every poll: the remembered session, then the remembered
 * name. Before the first match, the target may be a chatId, sessionId or name.
 */
export function resolveFocusTarget(
	chats: readonly CentralChat[],
	target: string,
	memory: CentralFocusMemory,
): CentralFocusResolution {
	let matches: CentralChat[] = [];
	if (memory.sessionId) matches = chats.filter(chat => chat.sessionId === memory.sessionId);
	if (matches.length === 0) {
		matches = chats.filter(chat => chat.id === target || chat.id.endsWith(`/${target}`) || chat.sessionId === target);
	}
	if (matches.length === 0) matches = byName(chats, memory.name ?? target);
	if (matches.length === 0 && memory.name !== undefined && memory.name !== target) matches = byName(chats, target);
	if (matches.length === 1) return { kind: "found", chat: matches[0]! };
	if (matches.length === 0) return { kind: "missing", message: `No chat matches "${target}"; retrying` };
	const listed = matches.map(
		chat =>
			`  ${sanitizeDisplayLine(chat.name) || "Untitled chat"} · ${sanitizeDisplayLine(chat.source ?? "local")} · session ${chat.sessionId} · chat ${chat.id}`,
	);
	return {
		kind: "ambiguous",
		message: `"${target}" matches ${matches.length} chats; use a sessionId or chatId:\n${listed.join("\n")}`,
	};
}

export type CentralFocusCommand =
	| { name: "chats" }
	| { name: "send"; chat: string; message: string }
	| { name: "dag" }
	| { name: "inbox"; count: number }
	| { name: "pause" }
	| { name: "resume" }
	| { name: "help" }
	/** Any other `/…`: run in the focused chat as if typed in its own composer. */
	| { name: "remote"; text: string }
	| { name: "error"; message: string };

/** Local Central commands, for `/help` and composer completion. */
export const CENTRAL_FOCUS_LOCAL_COMMANDS: ReadonlyArray<{ name: string; argumentHint?: string; description: string }> =
	[
		{ name: "chats", description: "all chats on every host, busy and open-question state" },
		{
			name: "send",
			argumentHint: "<chat> <msg>",
			description: 'ask the coordinator to relay <msg> to <chat> (quote a name with spaces: /send "MY CHAT" hi)',
		},
		{ name: "dag", description: "task board URL" },
		{ name: "inbox", argumentHint: "[N]", description: "last N coordinator inbox messages (default 10)" },
		{ name: "pause", description: "pause coordinator inbox steering" },
		{ name: "resume", description: "resume coordinator inbox steering" },
		{ name: "help", description: "this list" },
	];

/**
 * Focus composer completion: command names only, at the start of the draft. The
 * local Central commands (marked `local`) come first and win a name clash; then
 * the focused chat's advertised list. No `@` file or path completion: this host's
 * filesystem is not the chat's.
 */
export class CentralFocusAutocompleteProvider implements AutocompleteProvider {
	readonly #base: CombinedAutocompleteProvider;

	constructor(remote: readonly CentralCommandInfo[]) {
		const commands: SlashCommand[] = CENTRAL_FOCUS_LOCAL_COMMANDS.map(command => ({
			name: command.name,
			description: `local · ${command.description}`,
			argumentHint: command.argumentHint,
		}));
		for (const command of remote) {
			if (CENTRAL_FOCUS_LOCAL_COMMANDS.some(local => local.name === command.name)) continue;
			commands.push({
				name: command.name,
				aliases: command.aliases,
				description: command.description,
				argumentHint: command.argumentHint,
			});
		}
		this.#base = new CombinedAutocompleteProvider(commands, "/");
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		if (cursorLine !== 0 || !/^\s*\/[^\s/]*$/.test(before)) return null;
		return this.#base.getSuggestions(lines, cursorLine, cursorCol);
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		return this.#base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		return /^\s*\/[^\s/]*$/.test(textBeforeCursor) ? this.#base.trySyncSlashCompletion(textBeforeCursor) : null;
	}
}

/** `/help`: the local commands, then the focused chat's own command names (it may list hundreds). */
export function focusHelpLines(remote: readonly CentralCommandInfo[] | undefined, canCommand: boolean): string[] {
	const lines = ["Local commands (run here, never sent to the focused chat):"];
	for (const command of CENTRAL_FOCUS_LOCAL_COMMANDS) {
		const usage = `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
		lines.push(`  ${usage.padEnd(22)} ${command.description}`);
	}
	if (!canCommand) {
		lines.push("Chat commands: unavailable; update OMP on the chat's host. Other text is sent to the focused chat.");
		return lines;
	}
	lines.push("Chat commands (any other /command runs in the focused chat, as if typed there; / completes):");
	const names = (remote ?? [])
		.filter(command => !CENTRAL_FOCUS_LOCAL_COMMANDS.some(local => local.name === command.name))
		.map(command => `/${command.name}`);
	lines.push(`  ${names.join("  ") || "(the chat listed none)"}`);
	lines.push("Other text is sent to the focused chat.");
	return lines;
}

/** `undefined`: ordinary text for the focused chat. Local commands win; any other `/…` is `remote`. */
export function parseFocusCommand(text: string): CentralFocusCommand | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const match = /^\/(\S*)\s*([\s\S]*)$/.exec(trimmed)!;
	const name = match[1]!;
	const rest = match[2]!;
	const usage = (message: string): CentralFocusCommand => ({ name: "error", message });
	switch (name) {
		case "chats":
		case "dag":
		case "pause":
		case "resume":
		case "help":
			return rest ? usage(`/${name} takes no arguments · /help lists commands`) : { name };
		case "inbox": {
			if (!rest) return { name, count: 10 };
			const count = /^\d+$/.test(rest) ? Number(rest) : Number.NaN;
			return Number.isSafeInteger(count) && count >= 1 && count <= 500
				? { name, count }
				: usage("Usage: /inbox [N] with N from 1 to 500");
		}
		case "send": {
			const quoted = /^"([^"]+)"\s+([\s\S]+)$/.exec(rest);
			const plain = /^([^\s"]+)\s+([\s\S]+)$/.exec(rest);
			const parts = quoted ?? plain;
			if (!parts || !parts[2]!.trim())
				return usage('Usage: /send <chat> <msg> (quote a name with spaces: /send "MY CHAT" hi)');
			return { name, chat: parts[1]!, message: parts[2]! };
		}
		default:
			return name && !name.startsWith("/")
				? { name: "remote", text: trimmed }
				: usage("Type a command name after / · /help lists commands");
	}
}

/** `/chats`: every listed chat, including last-known entries of chats that stopped answering. */
export function focusChatLines(snapshot: CentralSnapshot, focusedChatId: string | undefined): string[] {
	const lines = snapshot.chats.map(chat => {
		const questions = chat.requests.length;
		const state = chat.unresponsive ? `not responding (${chat.unresponsive})` : chat.busy ? "busy" : "idle";
		return `${chat.id === focusedChatId ? "❯" : " "} ${chat.busy ? "●" : "○"} ${sanitizeDisplayLine(chat.name) || "Untitled chat"} · ${sanitizeDisplayLine(chat.source ?? "local")} · ${state} · ${questions ? `${questions} open question${questions === 1 ? "" : "s"}` : "no question"}`;
	});
	if (lines.length === 0) lines.push("No chats listed.");
	for (const error of snapshot.errors) lines.push(`! ${sanitizeDisplayLine(error)}`);
	return lines;
}
