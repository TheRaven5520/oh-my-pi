import { describe, expect, it, spyOn } from "bun:test";
import { CentralQueue } from "@oh-my-pi/pi-tui/apps/central/queue";
import type { CentralChat } from "@oh-my-pi/pi-tui/apps/central/types";
import * as bridge from "../src/central/bridge";
import { CentralSources } from "../src/central/sources";

const chat: CentralChat = {
	id: "chat",
	sessionId: "session",
	pid: 1,
	name: "Chat with an unsent answer",
	cwd: "/workspace",
	busy: false,
	requests: [{ id: "question", createdAt: 1, kind: "editor", title: "Review this" }],
};

// Exercise the real JSONL transport without opening an SSH connection. A failed
// write takes SshCentralSource's normal disconnect/reconnect path.
function sshProcess(reply: (request: Record<string, unknown>) => Record<string, unknown>) {
	const exited = Promise.withResolvers<number>();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	return {
		stdout: new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
		}),
		stdin: {
			write(line: string) {
				const request = JSON.parse(line) as Record<string, unknown>;
				controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: request.id, ...reply(request) })}\n`));
				return line.length;
			},
			flush: async () => 0,
			end: () => 0,
		},
		exited: exited.promise,
		kill() {
			if (closed) return;
			closed = true;
			controller.close();
			exited.resolve(0);
		},
	} as unknown as Bun.Subprocess<"pipe", "pipe", "ignore">;
}

describe("Central source poll retention", () => {
	for (const source of ["local", "remote-host"] as const) {
		it(`retains ${source} drafts through failed polls, blocks disconnected actions, and retires on successful removal`, async () => {
			let chats: CentralChat[] = [chat];
			let failure: Error | undefined;
			const remoteRequests: Record<string, unknown>[] = [];
			const list = spyOn(bridge, "listCentralChats").mockImplementation(async () => {
				if (source !== "local") return [];
				if (failure) throw failure;
				return chats;
			});
			const transcript = spyOn(bridge, "getCentralChatTranscript").mockResolvedValue([]);
			const answer = spyOn(bridge, "answerCentralQuestion").mockResolvedValue(undefined);
			const spawn = spyOn(Bun, "spawn").mockImplementation((() =>
				sshProcess(request => {
					remoteRequests.push(request);
					if (failure) throw failure;
					if (request.op === "list") return { chats };
					if (request.op === "transcript") return { transcript: [] };
					if (request.op === "answer") return { ok: true };
					throw new Error("Unexpected Central request");
				})) as typeof Bun.spawn);
			const sources = new CentralSources(source === "local" ? [] : [source]);
			const queue = new CentralQueue<{ text: string }>();
			try {
				const initial = await sources.refresh();
				expect(initial.errors).toEqual([]);
				expect(initial.chats).toEqual([{ ...chat, id: `${source}/chat`, source }]);
				queue.update(initial.chats);
				const entry = queue.current!;
				const draft = { text: "Do not discard this unsent answer" };
				entry.draft = draft;

				failure = new Error("Poll unavailable");
				for (let attempt = 0; attempt < 2; attempt++) {
					const unavailable = await sources.refresh();
					expect(unavailable.errors).toHaveLength(1);
					expect(unavailable.errors[0]).toStartWith(`${source}: `);
					expect(unavailable.chats).toEqual(initial.chats);
					expect(queue.update(unavailable.chats)).toEqual([]);
					expect(queue.current).toBe(entry);
					expect(queue.current?.draft).toBe(draft);
					const requestCount = remoteRequests.length;
					await expect(sources.transcript(entry.chat.id)).rejects.toThrow("Chat is disconnected");
					await expect(sources.answer(entry.chat.id, entry.request.id, "answer")).rejects.toThrow(
						"Chat is disconnected",
					);
					await expect(sources.open(entry.chat.id)).rejects.toThrow("Chat is disconnected");
					expect(transcript).not.toHaveBeenCalled();
					expect(answer).not.toHaveBeenCalled();
					expect(remoteRequests).toHaveLength(requestCount);
				}

				failure = undefined;
				const recovered = await sources.refresh();
				expect(recovered.errors).toEqual([]);
				expect(recovered.chats).toEqual(initial.chats);
				expect(queue.update(recovered.chats)).toEqual([]);
				expect(queue.current?.draft).toBe(draft);
				await expect(sources.transcript(entry.chat.id)).resolves.toEqual([]);
				await sources.answer(entry.chat.id, entry.request.id, "answer");
				if (source === "local") {
					expect(transcript).toHaveBeenCalledWith("chat");
					expect(answer).toHaveBeenCalledWith("chat", "question", "answer");
				} else {
					expect(remoteRequests.slice(-2)).toMatchObject([
						{ op: "transcript", chatId: "chat" },
						{ op: "answer", chatId: "chat", requestId: "question", answer: "answer" },
					]);
				}

				failure = new Error("Poll unavailable again");
				const interrupted = await sources.refresh();
				expect(interrupted.errors).toHaveLength(1);
				expect(queue.update(interrupted.chats)).toEqual([]);
				expect(queue.current?.draft).toBe(draft);
				failure = undefined;
				chats = [];
				const removed = await sources.refresh();
				expect(removed).toEqual({ chats: [], errors: [] });
				expect(queue.update(removed.chats)).toEqual([entry]);
				expect(queue.has(entry)).toBe(false);
				expect(queue.current).toBeUndefined();
				await expect(sources.transcript(entry.chat.id)).rejects.toThrow("Chat is disconnected");
				await expect(sources.answer(entry.chat.id, entry.request.id, "answer")).rejects.toThrow(
					"Chat is disconnected",
				);
				await expect(sources.open(entry.chat.id)).rejects.toThrow("Chat is no longer available");
			} finally {
				sources.close();
				spawn.mockRestore();
				answer.mockRestore();
				transcript.mockRestore();
				list.mockRestore();
			}
		});
	}
});
