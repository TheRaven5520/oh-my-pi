import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as clipboard from "../src/utils/clipboard";
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

describe("Central source image paste loading", () => {
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

	async function setup() {
		const directory = await mkdtemp(join(tmpdir(), "omp-central-paste-"));
		const imagePath = join(directory, "screen shot.png");
		await Bun.write(imagePath, Buffer.from(png, "base64"));
		const readImage = spyOn(clipboard, "readImageFromClipboard").mockResolvedValue(null);
		const readText = spyOn(clipboard, "readTextFromClipboard").mockResolvedValue("");
		const readFiles = spyOn(clipboard, "readMacFileUrlsFromClipboard").mockResolvedValue([]);
		const sources = new CentralSources();
		return {
			sources, imagePath, readImage, readText, readFiles,
			close: async () => {
				sources.close();
				readImage.mockRestore();
				readText.mockRestore();
				readFiles.mockRestore();
				await rm(directory, { recursive: true, force: true });
			},
		};
	}

	it("loads a pasted local image path into bytes without reading the clipboard", async () => {
		const rig = await setup();
		try {
			const value = await rig.sources.readPromptPaste(rig.imagePath);
			expect(value.text).toBe("");
			expect(value.images).toHaveLength(1);
			expect(value.images![0]).toMatchObject({ type: "image", mimeType: expect.stringMatching(/^image\//) });
			expect(Buffer.from(value.images![0]!.data, "base64").length).toBeGreaterThan(0);
			expect(rig.readImage).not.toHaveBeenCalled();
			expect(rig.readText).not.toHaveBeenCalled();
			expect(rig.readFiles).not.toHaveBeenCalled();
		} finally { await rig.close(); }
	});

	it("normalizes clipboard image bytes rather than returning clipboard text", async () => {
		const rig = await setup();
		try {
			rig.readImage.mockResolvedValue({ data: Buffer.from(png, "base64"), mimeType: "image/png" });
			rig.readText.mockResolvedValue("not the image");
			const value = await rig.sources.readPromptPaste();
			expect(value.text).toBe("");
			expect(value.images).toHaveLength(1);
			expect(Buffer.from(value.images![0]!.data, "base64").length).toBeGreaterThan(0);
			expect(value.images![0]!.type).toBe("image");
		} finally { await rig.close(); }
	});

	it("prefers Finder file selections over clipboard bitmap and text", async () => {
		const rig = await setup();
		try {
			rig.readFiles.mockResolvedValue([rig.imagePath]);
			const value = await rig.sources.readPromptPaste();
			expect(value.images).toHaveLength(1);
			expect(value.text).toBe("");
			expect(rig.readImage).not.toHaveBeenCalled();
			expect(rig.readText).not.toHaveBeenCalled();
		} finally { await rig.close(); }
	});

	for (const encoding of ["quoted", "file-url"] as const) {
		it(`loads image paths from ${encoding} clipboard text`, async () => {
			const rig = await setup();
			try {
				rig.readText.mockResolvedValue(encoding === "quoted" ? `'${rig.imagePath}'` : pathToFileURL(rig.imagePath).href);
				const value = await rig.sources.readPromptPaste();
				expect(value.text).toBe("");
				expect(value.images).toHaveLength(1);
				expect(value.images![0]!.data.length).toBeGreaterThan(0);
			} finally { await rig.close(); }
		});
	}

	it("preserves ordinary clipboard text and reports an empty clipboard as empty", async () => {
		const rig = await setup();
		try {
			rig.readText.mockResolvedValue("a plain answer\nwith another line");
			expect(await rig.sources.readPromptPaste()).toEqual({ text: "a plain answer\nwith another line" });
			rig.readText.mockResolvedValue("");
			expect(await rig.sources.readPromptPaste()).toEqual({ text: "" });
		} finally { await rig.close(); }
	});

	it("rejects missing and non-image paths rather than passing them through as answers", async () => {
		const rig = await setup();
		try {
			await expect(rig.sources.readPromptPaste(`${rig.imagePath}.missing.png`)).rejects.toThrow();
			await Bun.write(rig.imagePath, "not image bytes");
			await expect(rig.sources.readPromptPaste(rig.imagePath)).rejects.toThrow("Not a supported image");
		} finally { await rig.close(); }
	});

	it("rejects unsupported clipboard image formats without silently falling back to text", async () => {
		const rig = await setup();
		try {
			rig.readImage.mockResolvedValue({ data: Buffer.from("not an image"), mimeType: "image/tiff" });
			rig.readText.mockResolvedValue("misleading fallback");
			await expect(rig.sources.readPromptPaste()).rejects.toThrow("Unsupported clipboard image format");
		} finally { await rig.close(); }
	});
});
