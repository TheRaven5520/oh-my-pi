import { describe, expect, it } from "bun:test";
import { isPrivateSessionFile, isPrivateSessionText } from "@oh-my-pi/pi-coding-agent/session/private-chat";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

/**
 * Contracts for Sprilicred private mode as omp reads it from a stored session:
 * a user message that is exactly `` `private` `` (harness text beside it set
 * aside) whose next reply is the gateway's own "OK" makes the chat private,
 * wherever in the file it sits; a sentence that mentions the word, or a model
 * that answered it, does not.
 */

const SESSION_DIR = "/sessions/private-proj";

function line(obj: unknown): string {
	return `${JSON.stringify(obj)}\n`;
}

function header(id: string): string {
	return line({ type: "session", version: 3, id, cwd: "/proj", timestamp: new Date().toISOString() });
}

let nextEntryId = 0;
function msg(message: unknown): string {
	nextEntryId += 1;
	const timestamp = new Date().toISOString();
	return line({ type: "message", id: `e${nextEntryId}`, parentId: null, timestamp, message });
}

const typed = (...parts: string[]) => msg({ role: "user", content: parts.map(text => ({ type: "text", text })) });
const reply = (text: string) =>
	msg({ role: "assistant", provider: "anthropic", model: "m", stopReason: "stop", content: [{ type: "text", text }] });
const REMINDER = "<system-reminder>\nYou stopped with 2 incomplete todo items.\n</system-reminder>";

describe("private chat detection", () => {
	it("a typed `private` answered by the gateway's OK makes the chat private", () => {
		const session = header("p") + typed("hello") + reply("hi") + typed("`private`") + reply("OK");
		expect(isPrivateSessionText(session + typed("secret") + reply("done"))).toBe(true);
	});

	it("sets aside harness text beside and after the typed trigger", () => {
		// A reminder block of its own before the typed one, and omp's reminder message before the reply.
		const ownBlock = header("a") + typed(REMINDER, "`private`") + typed(REMINDER) + reply("OK");
		expect(isPrivateSessionText(ownBlock)).toBe(true);
		// A notice at the front of the typed block itself.
		const notice = "<system-notice>\nUser interjection.\n</system-notice>\n`private`\n";
		const front = header("b") + typed(notice) + reply("OK");
		expect(isPrivateSessionText(front)).toBe(true);
	});

	it("a sentence that mentions `private`, or anything typed beside it, is not the trigger", () => {
		expect(isPrivateSessionText(header("s") + typed("keep the `private` field") + reply("OK"))).toBe(false);
		expect(isPrivateSessionText(header("t") + typed("`private`", "and make it fast") + reply("OK"))).toBe(false);
		const withImage = msg({
			role: "user",
			content: [
				{ type: "text", text: "`private`" },
				{ type: "image", data: "", mimeType: "image/png" },
			],
		});
		expect(isPrivateSessionText(header("i") + withImage + reply("OK"))).toBe(false);
	});

	it("a trigger a model answered, or never answered, is not private", () => {
		expect(isPrivateSessionText(header("m") + typed("`private`") + reply("Sure — what should stay private?"))).toBe(
			false,
		);
		// The person typed again before any reply: the next "OK" answers that, not the trigger.
		expect(isPrivateSessionText(header("n") + typed("`private`") + typed("never mind") + reply("OK"))).toBe(false);
		expect(isPrivateSessionText(header("u") + typed("`private`"))).toBe(false);
	});
});

describe("private session files", () => {
	it("leaves a private session out of a listing even when the trigger sits mid-file", async () => {
		const storage = new MemorySessionStorage();
		// Far past the listing's 4 KB head window, and followed by more than its 32 KB tail window.
		const before = typed(`earlier ${"x".repeat(6000)}`) + reply(`noted ${"y".repeat(2000)}`);
		let after = "";
		for (let i = 0; i < 6; i++) {
			after += typed(`later ${i} ${"z".repeat(4000)}`) + reply(`answer ${"w".repeat(4000)}`);
		}
		const write = (id: string, turns: string) =>
			storage.writeTextSync(`${SESSION_DIR}/${id}.jsonl`, header(id) + turns);
		write("private-long", before + typed("`private`") + reply("OK") + after);
		write("mentions", typed("make the field `private`") + reply("OK"));
		write("answered", typed("`private`") + reply("What should I keep private?"));

		const listed = await SessionManager.list("/proj", SESSION_DIR, storage);
		expect(listed.map(session => session.id).sort()).toEqual(["answered", "mentions", "private-long"]);
		const shown: string[] = [];
		for (const session of listed) if (!(await isPrivateSessionFile(session.path, storage))) shown.push(session.id);
		expect(shown.sort()).toEqual(["answered", "mentions"]);
	});

	it("a session still being written becomes private once the gateway's OK lands", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/live.jsonl`;
		storage.writeTextSync(file, header("live") + typed("hello") + reply("hi"));
		expect(await isPrivateSessionFile(file, storage)).toBe(false);
		storage.appendSync(file, typed("`private`"));
		expect(await isPrivateSessionFile(file, storage)).toBe(false);
		storage.appendSync(file, reply("OK"));
		expect(await isPrivateSessionFile(file, storage)).toBe(true);
	});
});
