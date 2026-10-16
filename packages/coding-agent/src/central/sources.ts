import type { ImageContent } from "@oh-my-pi/pi-ai";
import { extractImagePastePathsFromText } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { readImageFromClipboard, readTextFromClipboard, readMacFileUrlsFromClipboard } from "../utils/clipboard";
import { loadImageInput, loadImageAttachmentInput } from "../utils/image-loading";
import type { Subprocess } from "bun";
import { $ } from "bun";
import { $which, isRecord } from "@oh-my-pi/pi-utils";
import { ConcatSink } from "@oh-my-pi/pi-utils/stream";
import type { CentralAnswer, CentralChat, CentralSnapshot, CentralTuiHost } from "@oh-my-pi/pi-tui/apps/central/types";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { answerCentralQuestion, getCentralChatTranscript, listCentralChats, parseCentralChat } from "./bridge";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEADLINE_MS = 15_000;

/** A bounded JSONL frame reader shared by the SSH client and its stdio endpoint. */
export async function* centralLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const buffer = new ConcatSink();
	for await (const chunk of stream) {
		for (const line of buffer.appendAndFlushLines(chunk)) {
			if (line.byteLength > MAX_LINE_BYTES) throw new Error("Central frame is too large");
			yield new TextDecoder().decode(line);
		}
		if ((buffer.flush()?.byteLength ?? 0) > MAX_LINE_BYTES) throw new Error("Central frame is too large");
	}
	if (!buffer.isEmpty) throw new Error("Incomplete Central frame");
}

type BridgeRequest =
	| { op: "list" }
	| { op: "transcript"; chatId: string }
	| { op: "answer"; chatId: string; requestId: string; answer: CentralAnswer };

/** No network listener: SSH supplies authenticated stdin/stdout. */
export async function serveCentralStdio(): Promise<void> {
	for await (const line of centralLines(Bun.stdin.stream())) {
		let id: unknown;
		try {
			const request: unknown = JSON.parse(line);
			if (!isRecord(request) || !Number.isSafeInteger(request.id)) throw new Error("Invalid Central request");
			id = request.id;
			if (request.op === "list") {
				process.stdout.write(`${JSON.stringify({ id, chats: await listCentralChats() })}\n`);
			} else if (request.op === "transcript" && typeof request.chatId === "string") {
				process.stdout.write(
					`${JSON.stringify({ id, transcript: await getCentralChatTranscript(request.chatId) })}\n`,
				);
			} else if (
				request.op === "answer" &&
				typeof request.chatId === "string" &&
				typeof request.requestId === "string"
			) {
				// The owning process validates the answer against its live question.
				await answerCentralQuestion(request.chatId, request.requestId, request.answer as CentralAnswer);
				process.stdout.write(`${JSON.stringify({ id, ok: true })}\n`);
			} else throw new Error("Invalid Central operation");
		} catch {
			// Answers and room credentials must never be reflected into diagnostics.
			process.stdout.write(
				`${JSON.stringify({ id, error: "Question unavailable or answer rejected; refresh and try again" })}\n`,
			);
		}
	}
}

interface PendingRequest {
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

const REMOTE_COMMAND =
	'unset OMP_LAUNCHER_OWNS_CLI; if [ -x "$HOME/.local/bin/omp" ]; then exec "$HOME/.local/bin/omp" central --bridge; elif [ -x "$HOME/.bun/bin/omp" ]; then exec "$HOME/.bun/bin/omp" central --bridge; else exec omp central --bridge; fi';

/** One authenticated SSH connection per explicitly configured host, not per poll. */
class SshCentralSource {
	#process?: Subprocess<"pipe", "pipe", "ignore">;
	#pending = new Map<number, PendingRequest>();
	#nextId = 0;
	#closed = false;
	readonly destination: string;
	readonly identity: string | undefined;
	constructor(destination: string, identity?: string) {
		this.destination = destination;
		this.identity = identity?.startsWith("~/") ? `${process.env.HOME ?? ""}/${identity.slice(2)}` : identity;
		if (!/^[a-zA-Z0-9_][-a-zA-Z0-9_.@:]*$/.test(destination)) throw new Error("Invalid Central SSH destination");
	}

	#connect(): Subprocess<"pipe", "pipe", "ignore"> {
		if (this.#closed) throw new Error("Central connection is closed");
		if (this.#process) return this.#process;
		const argv = [
			"/usr/bin/ssh",
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=8",
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=2",
		];
		if (this.identity) argv.push("-i", this.identity, "-o", "IdentitiesOnly=yes");
		argv.push(this.destination, REMOTE_COMMAND);
		const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
		this.#process = child;
		void this.#read(child).catch(() => this.#disconnect(child));
		void child.exited.then(() => this.#disconnect(child));
		return child;
	}

	async #read(child: Subprocess<"pipe", "pipe", "ignore">): Promise<void> {
		for await (const line of centralLines(child.stdout)) {
			const reply: unknown = JSON.parse(line);
			if (!isRecord(reply) || typeof reply.id !== "number") throw new Error("Invalid Central response");
			if (this.#process !== child) return;
			const pending = this.#pending.get(reply.id);
			if (!pending) continue;
			this.#pending.delete(reply.id);
			clearTimeout(pending.timer);
			if (reply.error) pending.reject(new Error("Remote question unavailable or answer rejected"));
			else pending.resolve(reply);
		}
		this.#disconnect(child);
	}

	#disconnect(child: Subprocess<"pipe", "pipe", "ignore">): void {
		if (this.#process !== child) return;
		this.#process = undefined;
		child.stdin.end();
		child.kill();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("SSH disconnected; check access and install the Central-capable OMP on this host"));
		}
		this.#pending.clear();
	}

	async request(request: BridgeRequest): Promise<Record<string, unknown>> {
		const child = this.#connect();
		const id = ++this.#nextId;
		const line = `${JSON.stringify({ ...request, id })}\n`;
		if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("Answer is too large");
		const result = Promise.withResolvers<Record<string, unknown>>();
		const timer = setTimeout(() => this.#disconnect(child), DEADLINE_MS);
		this.#pending.set(id, { ...result, timer });
		try {
			child.stdin.write(line);
			await child.stdin.flush();
		} catch {
			this.#disconnect(child);
		}
		return result.promise;
	}

	close(): void {
		this.#closed = true;
		if (this.#process) this.#disconnect(this.#process);
	}
}

interface Source {
	name: string;
	remote?: SshCentralSource;
	chats: CentralChat[];
	available: boolean;
}

/** Aggregates local and SSH-hosted registries without ever copying a chat transcript. */
export class CentralSources implements CentralTuiHost {
	#sources: Source[];
	#routes = new Map<string, { source: Source; local: CentralChat }>();
	#closed = false;
	constructor(hosts: readonly string[] = [], identity?: string) {
		this.#sources = [
			{ name: "local", chats: [], available: true },
			...[...new Set(hosts)].map(name => ({
				name,
				remote: new SshCentralSource(name, identity),
				chats: [],
				available: false,
			})),
		];
	}

	async readPromptPaste(path?: string): Promise<{ text: string; images?: ImageContent[] }> {
		const loadPath = async (path: string): Promise<ImageContent> => {
			const loaded = await loadImageInput({ path, cwd: process.cwd(), autoResize: true });
			if (!loaded) throw new Error(`Not a supported image: ${path}`);
			return { type: "image", data: loaded.data, mimeType: loaded.mimeType };
		};
		if (path !== undefined) return { text: "", images: [await loadPath(path)] };
		const paths = await readMacFileUrlsFromClipboard();
		if (paths.length > 0) return { text: "", images: await Promise.all(paths.map(loadPath)) };
		const image = await readImageFromClipboard();
		if (image) {
			const loaded = await loadImageAttachmentInput({
				image: { type: "image", data: image.data.toBase64(), mimeType: image.mimeType },
				uri: "clipboard",
				label: "clipboard",
				autoResize: true,
			});
			if (!loaded) throw new Error(`Unsupported clipboard image format: ${image.mimeType}`);
			return { text: "", images: [{ type: "image", data: loaded.data, mimeType: loaded.mimeType }] };
		}
		const text = (await readTextFromClipboard()) ?? "";
		const imagePaths = extractImagePastePathsFromText(text);
		return imagePaths ? { text: "", images: await Promise.all(imagePaths.map(loadPath)) } : { text };
	}

	async refresh(): Promise<CentralSnapshot> {
		const errors: string[] = [];
		await Promise.all(
			this.#sources.map(async source => {
				try {
					const data = source.remote
						? (await source.remote.request({ op: "list" })).chats
						: await listCentralChats();
					if (!Array.isArray(data)) throw new Error("Incompatible Central response");
					const chats = data.map(parseCentralChat);
					if (chats.some(chat => !chat)) throw new Error("Incompatible Central response");
					source.chats = chats as CentralChat[];
					source.available = true;
				} catch (error) {
					source.available = false;
					// A failed poll cannot establish that a pending question was withdrawn.
					// Keep its draft until a successful snapshot replaces the last known chats.
					errors.push(`${source.name}: ${error instanceof Error ? error.message : "Connection failed"}`);
				}
			}),
		);
		if (this.#closed) return { chats: [], errors: [] };
		this.#routes.clear();
		const chats: CentralChat[] = [];
		for (const source of this.#sources) {
			for (const local of source.chats) {
				const id = `${source.name}/${local.id}`;
				this.#routes.set(id, { source, local });
				chats.push({ ...local, id, source: source.name });
			}
		}
		return { chats, errors };
	}

	async transcript(chatId: string) {
		const route = this.#routes.get(chatId);
		if (!route || !route.source.available || this.#closed)
			throw new Error("Chat is disconnected; wait for it to reconnect");
		if (route.source.remote) {
			const reply = await route.source.remote.request({ op: "transcript", chatId: route.local.id });
			if (!Array.isArray(reply.transcript)) throw new Error("Invalid Central transcript");
			return reply.transcript as TranscriptEntryLike[];
		}
		return getCentralChatTranscript(route.local.id);
	}

	async answer(chatId: string, requestId: string, answer: CentralAnswer): Promise<void> {
		const route = this.#routes.get(chatId);
		if (!route || !route.source.available || this.#closed)
			throw new Error("Chat is disconnected; wait for it to reconnect");
		if (!route.local.requests.some(request => request.id === requestId))
			throw new Error("Question was already answered or withdrawn");
		if (route.source.remote) {
			const reply = await route.source.remote.request({ op: "answer", chatId: route.local.id, requestId, answer });
			if (reply.ok !== true) throw new Error("Answer was not acknowledged; refresh before retrying");
		} else await answerCentralQuestion(route.local.id, requestId, answer);
	}

	async open(chatId: string): Promise<void> {
		const route = this.#routes.get(chatId);
		if (!route) throw new Error("Chat is no longer available");
		if (!route.source.available || this.#closed) throw new Error("Chat is disconnected; wait for it to reconnect");
		const location = route.local.location;
		if (!location) throw new Error(`Open ${route.local.name} in its original terminal`);
		if (route.source.remote)
			throw new Error(`Open ${route.source.name} and select ${route.local.name} in tmux (${location.pane})`);
		const ownSocket = /^(.*),\d+,\d+$/.exec(process.env.TMUX ?? "")?.[1];
		if (ownSocket !== location.socket)
			throw new Error(`Open ${route.local.name} in its original tmux server (${location.pane})`);
		const ownPane = process.env.TMUX_PANE;
		if (!ownPane || !/^%\d+$/.test(ownPane))
			throw new Error("Cannot identify Central's tmux pane; open the chat in its original terminal");
		const tmux = $which("tmux");
		if (!tmux) throw new Error("tmux is not installed");
		// tmux's implicit client selection can choose another user's most-active
		// client. Only switch an unambiguous terminal currently displaying Central.
		const format = "#{client_name}\t#{pane_id}\t#{client_control_mode}";
		const clients = await $`${tmux} -S ${location.socket} list-clients -F ${format}`.quiet().text();
		const callers = clients
			.trim()
			.split("\n")
			.map(line => line.split("\t"))
			.filter(([name, pane, control]) => name && pane === ownPane && control === "0");
		if (callers.length !== 1)
			throw new Error(
				"Cannot identify a unique tmux client displaying Central; open the chat in its original terminal",
			);
		await $`${tmux} -S ${location.socket} switch-client -c ${callers[0][0]} -t ${location.pane}`.quiet();
	}

	close(): void {
		this.#closed = true;
		for (const source of this.#sources) source.remote?.close();
		this.#routes.clear();
	}
}
