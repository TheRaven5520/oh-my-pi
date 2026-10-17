import { describe, expect, it, spyOn } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as clipboard from "../src/utils/clipboard";
import { CentralQueue } from "@oh-my-pi/pi-tui/apps/central/queue";
import type { CentralChat } from "@oh-my-pi/pi-tui/apps/central/types";
import { CentralPromptRejectedError } from "@oh-my-pi/pi-tui/apps/central/types";
import * as utils from "@oh-my-pi/pi-utils";
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
					await expect(sources.workspace(entry.chat.id, 80, 20)).rejects.toThrow("Chat is disconnected");
					await expect(
						sources.prompt(entry.chat.id, entry.chat.sessionId, "request-one", "hello"),
					).rejects.toThrow("Chat is disconnected");
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

describe("Central source workspace and prompt routing", () => {
	for (const source of ["local", "remote-host"] as const) {
		it(`routes ${source} workspace and immutable prompt IDs without retrying sends`, async () => {
			const workspace = { statusLines: ["\x1b[38;2;10;20;30mModel\x1b[0m"], usageLines: ["42%"], canPrompt: true };
			const requests: Record<string, unknown>[] = [];
			let rejectPrompt = false;
			const list = spyOn(bridge, "listCentralChats").mockResolvedValue(source === "local" ? [chat] : []);
			const render = spyOn(bridge, "getCentralChatWorkspace").mockResolvedValue(workspace);
			const prompt = spyOn(bridge, "promptCentralChat").mockImplementation(async (_chatId, sessionId) => {
				if (sessionId === "stale") throw new CentralPromptRejectedError("stale_session");
				if (rejectPrompt) throw new Error("Delivery unknown");
			});
			const spawn = spyOn(Bun, "spawn").mockImplementation((() =>
				sshProcess(request => {
					requests.push(request);
					if (request.op === "list") return { chats: [chat] };
					if (request.op === "workspace") return { workspace };
					if (request.op === "prompt")
						return request.sessionId === "stale"
							? { error: "stale_session", confirmedNoAdmission: true }
							: rejectPrompt
								? { error: "unavailable" }
								: { ok: true };
					throw new Error("Unexpected request");
				})) as typeof Bun.spawn);
			const sources = new CentralSources(source === "local" ? [] : [source]);
			try {
				await sources.refresh();
				const id = `${source}/chat`;
				const rendered = await sources.workspace(id, 80, 20);
				expect(rendered.canPrompt).toBe(true);
				expect(rendered.statusLines[0]).toContain("\x1b[38;2;10;20;30m");
				await sources.prompt(id, "session", "stable-request", "hello");
				rejectPrompt = true;
				await expect(sources.prompt(id, "session", "stable-request", "hello")).rejects.not.toBeInstanceOf(
					CentralPromptRejectedError,
				);
				await expect(sources.prompt(id, "stale", "other-request", "hello")).rejects.toBeInstanceOf(
					CentralPromptRejectedError,
				);
				if (source === "local") {
					expect(render).toHaveBeenCalledWith("chat", 80, 20);
					expect(prompt).toHaveBeenCalledTimes(3);
					expect(prompt).toHaveBeenLastCalledWith("chat", "stale", "other-request", "hello");
				} else {
					expect(requests.filter(request => request.op === "prompt")).toMatchObject([
						{ chatId: "chat", sessionId: "session", requestId: "stable-request", text: "hello" },
						{ chatId: "chat", sessionId: "session", requestId: "stable-request", text: "hello" },
						{ chatId: "chat", sessionId: "stale", requestId: "other-request", text: "hello" },
					]);
				}
			} finally {
				sources.close();
				spawn.mockRestore();
				prompt.mockRestore();
				render.mockRestore();
				list.mockRestore();
			}
		});
	}
});

describe("Central source terminal opening", () => {
	const location = { socket: "/tmp/central-test-socket", pane: "%42" };
	for (const scenario of [
		{
			name: "opens a chat without questions in the caller's explicit client",
			clients: "/dev/pts/other\t%9\t0\n/dev/pts/caller\t%7\t0\n",
		},
		{
			name: "refuses a detached Central pane rather than switching another client",
			clients: "/dev/pts/other\t%9\t0\n",
			error: "unique tmux client",
		},
		{
			name: "refuses ambiguous clients displaying Central",
			clients: "/dev/pts/one\t%7\t0\n/dev/pts/two\t%7\t0\n",
			error: "unique tmux client",
		},
		{
			name: "does not treat a control-mode observer as the caller",
			clients: "control\t%7\t1\n",
			error: "unique tmux client",
		},
		{ name: "refuses an empty client list", clients: "", error: "unique tmux client" },
	]) {
		it(scenario.name, async () => {
			const dir = await mkdtemp(join(tmpdir(), "central-open-"));
			const executable = join(dir, "tmux");
			// Record argv without contacting any real tmux server or client.
			await Bun.write(
				executable,
				'#!/bin/sh\nprintf "%s\\n" "$@" >> "$0.args"\nif [ "$3" = list-clients ]; then cat "$0.clients"; fi\n',
			);
			await chmod(executable, 0o755);
			await Bun.write(`${executable}.clients`, scenario.clients);
			const which = spyOn(utils, "$which").mockReturnValue(executable);
			const list = spyOn(bridge, "listCentralChats").mockResolvedValue([{ ...chat, location, requests: [] }]);
			const previousTmux = process.env.TMUX;
			const previousPane = process.env.TMUX_PANE;
			process.env.TMUX = `${location.socket},123,0`;
			process.env.TMUX_PANE = "%7";
			const sources = new CentralSources();
			try {
				await sources.refresh();
				if (scenario.error) await expect(sources.open("local/chat")).rejects.toThrow(scenario.error);
				else await sources.open("local/chat");
				const args = (await Bun.file(`${executable}.args`).text()).trimEnd().split("\n");
				expect(args).toEqual([
					"-S",
					location.socket,
					"list-clients",
					"-F",
					"#{client_name}\t#{pane_id}\t#{client_control_mode}",
					...(!scenario.error
						? ["-S", location.socket, "switch-client", "-c", "/dev/pts/caller", "-t", "%42"]
						: []),
				]);
			} finally {
				sources.close();
				if (previousTmux === undefined) delete process.env.TMUX;
				else process.env.TMUX = previousTmux;
				if (previousPane === undefined) delete process.env.TMUX_PANE;
				else process.env.TMUX_PANE = previousPane;
				list.mockRestore();
				which.mockRestore();
				await rm(dir, { recursive: true, force: true });
			}
		});
	}

	for (const scenario of [
		{
			name: "direct-terminal chat",
			location: undefined,
			tmux: `${location.socket},123,0`,
			pane: "%7",
			error: "original terminal",
		},
		{ name: "different tmux server", location, tmux: "/tmp/other,123,0", pane: "%7", error: "original tmux server" },
		{ name: "Central outside tmux", location, tmux: undefined, pane: undefined, error: "original tmux server" },
		{
			name: "Central without a pane identity",
			location,
			tmux: `${location.socket},123,0`,
			pane: undefined,
			error: "Central's tmux pane",
		},
	]) {
		it(`keeps the manual-open constraint for ${scenario.name}`, async () => {
			const list = spyOn(bridge, "listCentralChats").mockResolvedValue([{ ...chat, location: scenario.location }]);
			const which = spyOn(utils, "$which").mockReturnValue(null);
			const previousTmux = process.env.TMUX;
			const previousPane = process.env.TMUX_PANE;
			if (scenario.tmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = scenario.tmux;
			if (scenario.pane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = scenario.pane;
			const sources = new CentralSources();
			try {
				await sources.refresh();
				await expect(sources.open("local/chat")).rejects.toThrow(scenario.error);
				expect(which).not.toHaveBeenCalled();
			} finally {
				sources.close();
				if (previousTmux === undefined) delete process.env.TMUX;
				else process.env.TMUX = previousTmux;
				if (previousPane === undefined) delete process.env.TMUX_PANE;
				else process.env.TMUX_PANE = previousPane;
				which.mockRestore();
				list.mockRestore();
			}
		});
	}

	it("never sends an open command through a remote source", async () => {
		const list = spyOn(bridge, "listCentralChats").mockResolvedValue([]);
		const requests: Record<string, unknown>[] = [];
		const spawn = spyOn(Bun, "spawn").mockImplementation((() =>
			sshProcess(request => {
				requests.push(request);
				return { chats: [{ ...chat, location, requests: [] }] };
			})) as typeof Bun.spawn);
		const sources = new CentralSources(["remote-host"]);
		try {
			await sources.refresh();
			await expect(sources.open("remote-host/chat")).rejects.toThrow("Open remote-host and select");
			expect(requests.map(request => request.op)).toEqual(["list"]);
		} finally {
			sources.close();
			spawn.mockRestore();
			list.mockRestore();
		}
	});
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
			sources,
			imagePath,
			readImage,
			readText,
			readFiles,
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
		} finally {
			await rig.close();
		}
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
		} finally {
			await rig.close();
		}
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
		} finally {
			await rig.close();
		}
	});

	for (const encoding of ["quoted", "file-url"] as const) {
		it(`loads image paths from ${encoding} clipboard text`, async () => {
			const rig = await setup();
			try {
				rig.readText.mockResolvedValue(
					encoding === "quoted" ? `'${rig.imagePath}'` : pathToFileURL(rig.imagePath).href,
				);
				const value = await rig.sources.readPromptPaste();
				expect(value.text).toBe("");
				expect(value.images).toHaveLength(1);
				expect(value.images![0]!.data.length).toBeGreaterThan(0);
			} finally {
				await rig.close();
			}
		});
	}

	it("preserves ordinary clipboard text and reports an empty clipboard as empty", async () => {
		const rig = await setup();
		try {
			rig.readText.mockResolvedValue("a plain answer\nwith another line");
			expect(await rig.sources.readPromptPaste()).toEqual({ text: "a plain answer\nwith another line" });
			rig.readText.mockResolvedValue("");
			expect(await rig.sources.readPromptPaste()).toEqual({ text: "" });
		} finally {
			await rig.close();
		}
	});

	it("rejects missing and non-image paths rather than passing them through as answers", async () => {
		const rig = await setup();
		try {
			await expect(rig.sources.readPromptPaste(`${rig.imagePath}.missing.png`)).rejects.toThrow();
			await Bun.write(rig.imagePath, "not image bytes");
			await expect(rig.sources.readPromptPaste(rig.imagePath)).rejects.toThrow("Not a supported image");
		} finally {
			await rig.close();
		}
	});

	it("rejects unsupported clipboard image formats without silently falling back to text", async () => {
		const rig = await setup();
		try {
			rig.readImage.mockResolvedValue({ data: Buffer.from("not an image"), mimeType: "image/tiff" });
			rig.readText.mockResolvedValue("misleading fallback");
			await expect(rig.sources.readPromptPaste()).rejects.toThrow("Unsupported clipboard image format");
		} finally {
			await rig.close();
		}
	});
});
