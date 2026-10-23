import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import type { TranscriptEntryLike } from "../../chat/transcript-entry";
import { sanitizeDisplayLine } from "../../overlays/extensions/display-text";
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
