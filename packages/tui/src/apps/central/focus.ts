import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import type { TranscriptEntryLike } from "../../chat/transcript-entry";
import { Markdown } from "../../components/markdown";
import { sanitizeDisplayLine } from "../../overlays/extensions/display-text";
import { clockDateTimeFormat } from "../../render/clock";
import { wrapTextWithAnsi } from "../../render/render-utils";
import { getMarkdownTheme, theme } from "../../theme/theme";
import { truncateToWidth } from "../../utils";
import type { CentralChat, CentralSnapshot } from "./types";

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

/** One turn of the focused conversation: a reply, or a message sent from the focus composer. */
export type CentralFocusTurn =
	| { kind: "reply"; id: string; at: number | undefined; text: string }
	| { kind: "sent"; id: string; at: number | undefined; text: string };

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
 * The conversation as turns: each assistant reply's text (no thinking or tool
 * calls), and each user message that begins with the focus `prefix` (shown
 * without it). Other user messages, tool results and custom messages are omitted.
 */
export function focusTurns(entries: readonly TranscriptEntryLike[], prefix: string): CentralFocusTurn[] {
	const turns: CentralFocusTurn[] = [];
	const replies = new Map(focusTranscriptEntries(entries).map(entry => [entry.id, entry]));
	for (const entry of entries) {
		const reply = replies.get(entry.id);
		if (reply?.type === "message" && reply.message.role === "assistant") {
			const text = (reply.message.content as TextContent[]).map(block => block.text).join("\n\n");
			turns.push({ kind: "reply", id: entry.id, at: entryTime(entry), text });
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "user" || !prefix) continue;
		const text = userText(entry.message.content);
		if (text?.startsWith(prefix))
			turns.push({ kind: "sent", id: entry.id, at: entryTime(entry), text: text.slice(prefix.length) });
	}
	return turns;
}

/** `10:38 PM` in the configured display time zone. */
export function focusTurnTime(at: number | undefined): string {
	if (at === undefined) return "time unknown";
	return clockDateTimeFormat({ hour: "numeric", minute: "2-digit", hour12: true }).format(at);
}

/**
 * Each reply under a `── 10:38 PM ──` divider, rendered as Markdown; each sent
 * message as a dimmed `you:` line. A `…working` line follows while the chat is busy.
 */
export function renderFocusTurns(turns: readonly CentralFocusTurn[], width: number, busy: boolean): string[] {
	const rows: string[] = [];
	const mdTheme = getMarkdownTheme();
	for (const turn of turns) {
		if (turn.kind === "sent") {
			const lines = wrapTextWithAnsi(
				`you: ${sanitizeDisplayLine(turn.text.replace(/\s*\n\s*/g, " "))}`,
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
	| { name: "error"; message: string };

export const CENTRAL_FOCUS_HELP = [
	"Local commands (run here, never sent to the focused chat):",
	"  /chats                 all chats on every host, busy and open-question state",
	'  /send <chat> <msg>     ask the coordinator to relay <msg> to <chat> (quote a name with spaces: /send "MY CHAT" hi)',
	"  /dag                   task board URL",
	"  /inbox [N]             last N coordinator inbox messages (default 10)",
	"  /pause                 pause coordinator inbox steering",
	"  /resume                resume coordinator inbox steering",
	"  /help                  this list",
	"Anything else starting with / is refused. Other text is sent to the focused chat.",
];

/** `undefined`: ordinary text for the focused chat. Every `/…` input is handled locally. */
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
			return usage(
				`Unknown command /${sanitizeDisplayLine(name).slice(0, 40)}; nothing was sent · /help lists commands`,
			);
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
