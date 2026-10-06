/**
 * Private chats (Sprilicred private mode).
 *
 * A person makes a chat private by typing exactly `` `private` `` as a user
 * message; the gateway answers "OK" itself and stores nothing after it. The
 * session file on this machine still holds the whole chat, so every omp surface
 * that lists or serves past sessions where a model can read them must leave a
 * private chat out: reading it into another chat would send it to a model the
 * private chat never reached.
 */
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { FileSessionStorage, type SessionStorage, type SessionStorageStat } from "./session-storage";

/** Exact text a person types to make a chat private. */
export const PRIVATE_CHAT_TRIGGER = "`private`";
/** The gateway's own reply to {@link PRIVATE_CHAT_TRIGGER}. */
export const PRIVATE_CHAT_ACK = "OK";

/** `<name attributes>` at the start of a harness element; names are lowercase words. */
const OPENING_TAG = /^<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>/;

/** What a person typed in one text part: the text without the harness elements it starts with. */
function typedText(text: string): string {
	let rest = text.trim();
	for (;;) {
		const open = OPENING_TAG.exec(rest);
		if (!open) return rest;
		const close = rest.indexOf(`</${open[1]}>`, open[0].length);
		if (close === -1) return rest;
		rest = rest.slice(close + open[1].length + 3).trim();
	}
}

/** The text of a content part, or `undefined` when the part is not text (an image, a tool call). */
function partText(part: unknown): string | undefined {
	if (typeof part === "string") return part;
	if (typeof part !== "object" || part === null) return undefined;
	const { type, text } = part as { type?: unknown; text?: unknown };
	return type === "text" && typeof text === "string" ? text : undefined;
}

/** True when a user message is the trigger and nothing else a person typed; harness text beside it is set aside. */
function isTrigger(content: unknown): boolean {
	if (typeof content === "string") return typedText(content) === PRIVATE_CHAT_TRIGGER;
	if (!Array.isArray(content)) return false;
	let found = false;
	for (const part of content) {
		const text = partText(part);
		if (text === undefined) return false;
		const typed = typedText(text);
		if (typed === "") continue;
		if (found || typed !== PRIVATE_CHAT_TRIGGER) return false;
		found = true;
	}
	return found;
}

/** True when a user message holds harness text alone: nothing a person typed. */
function isHarnessOnly(content: unknown): boolean {
	if (typeof content === "string") return typedText(content) === "";
	if (!Array.isArray(content)) return false;
	return content.every(part => {
		const text = partText(part);
		return text !== undefined && typedText(text) === "";
	});
}

/** True when an assistant message is exactly the gateway's "OK": text only, no thinking or tool call. */
function isAck(content: unknown): boolean {
	if (typeof content === "string") return content.trim() === PRIVATE_CHAT_ACK;
	if (!Array.isArray(content)) return false;
	let text = "";
	for (const part of content) {
		const partValue = partText(part);
		if (partValue === undefined) return false;
		text += partValue;
	}
	return text.trim() === PRIVATE_CHAT_ACK;
}

interface StoredMessage {
	role?: unknown;
	content?: unknown;
}

/** The message a session JSONL line records, if it records one. */
function messageOfLine(line: string): StoredMessage | undefined {
	if (line.length === 0) return undefined;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof entry !== "object" || entry === null) return undefined;
	const { type, message } = entry as { type?: unknown; message?: unknown };
	if (type !== "message" || typeof message !== "object" || message === null) return undefined;
	return message as StoredMessage;
}

/** Index of the newline ending the line that holds `offset`, or the end of the text. */
function lineEnd(content: string, offset: number): number {
	const end = content.indexOf("\n", offset);
	return end === -1 ? content.length : end;
}

/** True when the first reply after a trigger line ending at `from` is the gateway's "OK". */
function acknowledgedAfter(content: string, from: number): boolean {
	for (let start = from + 1; start < content.length; ) {
		const end = lineEnd(content, start);
		const message = messageOfLine(content.slice(start, end));
		start = end + 1;
		if (!message) continue;
		if (message.role === "assistant") return isAck(message.content);
		// omp's own reminders after the typed message are not an answer; anything typed is.
		if (message.role === "user" && !isHarnessOnly(message.content)) return false;
	}
	return false;
}

/**
 * True when a session JSONL holds a private chat: a user message that is exactly
 * {@link PRIVATE_CHAT_TRIGGER} whose next reply is the assistant's
 * {@link PRIVATE_CHAT_ACK}. Only lines holding the trigger text, and the few after
 * one, are parsed; text without it is never parsed at all.
 */
export function isPrivateSessionText(content: string): boolean {
	let at = content.indexOf(PRIVATE_CHAT_TRIGGER);
	while (at !== -1) {
		const end = lineEnd(content, at);
		const message = messageOfLine(content.slice(content.lastIndexOf("\n", at) + 1, end));
		if (message?.role === "user" && isTrigger(message.content) && acknowledgedAfter(content, end)) return true;
		at = content.indexOf(PRIVATE_CHAT_TRIGGER, end);
	}
	return false;
}

const PRIVATE_SESSION_CACHE_MAX = 4096;

interface PrivateSessionCacheEntry {
	mtimeMs: number;
	size: number;
	isPrivate: boolean;
}

type PrivateSessionCache = LRUCache<string, PrivateSessionCacheEntry>;

/** Every {@link FileSessionStorage} views the same filesystem, so they share one cache. */
const filePrivateSessionCache: PrivateSessionCache = new LRUCache({ max: PRIVATE_SESSION_CACHE_MAX });
/** Other storages (in-memory, Redis, SQL) each carry their own, so equal paths never collide. */
const otherPrivateSessionCaches = new WeakMap<SessionStorage, PrivateSessionCache>();

function privateSessionCache(storage: SessionStorage): PrivateSessionCache {
	if (storage instanceof FileSessionStorage) return filePrivateSessionCache;
	let cache = otherPrivateSessionCaches.get(storage);
	if (!cache) {
		cache = new LRUCache({ max: PRIVATE_SESSION_CACHE_MAX });
		otherPrivateSessionCaches.set(storage, cache);
	}
	return cache;
}

/**
 * True when the session file holds a private chat ({@link isPrivateSessionText}).
 * A session still being written counts: the file is read as it stands. Results
 * are cached per path by `mtimeMs` + `size`, so an unchanged file is never read
 * twice. A missing or unreadable file is not private (there is nothing to list).
 */
export async function isPrivateSessionFile(
	file: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<boolean> {
	let stat: SessionStorageStat;
	try {
		stat = storage.statSync(file);
	} catch {
		return false;
	}
	const { mtimeMs, size } = stat;
	const cache = privateSessionCache(storage);
	const cached = cache.get(file);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.isPrivate;
	let content: string;
	try {
		content = await storage.readText(file);
	} catch {
		return false;
	}
	const isPrivate = isPrivateSessionText(content);
	cache.set(file, { mtimeMs, size, isPrivate });
	return isPrivate;
}
