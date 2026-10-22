import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type {
	CentralAnswer,
	CentralChat,
	CentralRequest,
	CentralRequestDraft,
	CentralWorkspace,
} from "@oh-my-pi/pi-tui/apps/central/types";
import { CentralPromptRejectedError } from "@oh-my-pi/pi-tui/apps/central/types";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";
import {
	isCentralPrompt,
	isCentralRequestDraft,
	isCentralWorkspaceWidth,
	parseCentralChat,
	parseCentralWorkspace,
	validateCentralAnswer,
} from "./validation";

export { parseCentralChat } from "./validation";
export const CENTRAL_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const VERSION = 1;
const TIMEOUT_MS = 2_000;
const ID_PATTERN = /^[a-f0-9-]{32,36}$/;
const SUN_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;

type ChatState = Omit<CentralChat, "id" | "pid" | "requests" | "location" | "source">;
type Options = {
	dir?: string;
	onClosed?: () => void;
	getTranscript?: () => TranscriptEntryLike[];
	getWorkspace?: (statusWidth: number, usageWidth: number) => CentralWorkspace;
	/** Resolves only when the run/queue owns the input; rejects pre-acceptance failures. */
	prompt?: (sessionId: string, text: string) => Promise<void>;
};
export const CENTRAL_MAX_TRANSCRIPT_BYTES = 512 * 1024;

function trimTranscriptToBytes(entries: TranscriptEntryLike[]): TranscriptEntryLike[] {
	const tail: TranscriptEntryLike[] = [];
	let bytes = 2;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		const entryBytes = Buffer.byteLength(JSON.stringify(entry));
		const separatorBytes = tail.length > 0 ? 1 : 0;
		if (bytes + separatorBytes + entryBytes > CENTRAL_MAX_TRANSCRIPT_BYTES) break;
		tail.unshift(entry);
		bytes += separatorBytes + entryBytes;
	}
	return tail;
}

export interface CentralHost {
	readonly closed: boolean;
	race<T extends CentralAnswer | undefined>(
		request: CentralRequestDraft,
		signal: AbortSignal | undefined,
		local: (signal: AbortSignal) => Promise<T>,
	): Promise<T>;
	close(): Promise<void>;
}

interface Metadata {
	v: number;
	id: string;
	pid: number;
	endpoint: string;
	token: string;
}

interface Pending {
	request: CentralRequest;
	sessionId: string;
	answer(value: CentralAnswer): void;
	cancel(): void;
}

class IpcError extends Error {
	constructor(
		readonly code: string,
		readonly dead = false,
	) {
		super(`OMP Central: ${code}${code === "unsupported_operation" ? "; update OMP on the chat host" : ""}`);
	}
}

async function privateDirectory(dir: string, create = false): Promise<void> {
	if (create) await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await fs.promises.lstat(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
		throw new IpcError("unsafe_registry");
	}
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
		if (!create) throw new IpcError("unsafe_registry");
		await fs.promises.chmod(dir, 0o700);
	}
}

async function readMetadata(dir: string, id: string): Promise<Metadata | null> {
	if (!ID_PATTERN.test(id)) return null;
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(
			path.join(dir, `${id}.json`),
			fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
		);
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			stat.size > 16 * 1024 ||
			(process.getuid && stat.uid !== process.getuid()) ||
			(process.platform !== "win32" && (stat.mode & 0o077) !== 0)
		)
			throw new IpcError("invalid_metadata");
		const raw = JSON.parse(await handle.readFile("utf8")) as Partial<Metadata> | null;
		if (
			!raw ||
			raw.v !== VERSION ||
			raw.id !== id ||
			typeof raw.pid !== "number" ||
			!Number.isSafeInteger(raw.pid) ||
			raw.pid <= 0 ||
			typeof raw.endpoint !== "string" ||
			!raw.endpoint ||
			typeof raw.token !== "string" ||
			!/^[a-f0-9]{64}$/.test(raw.token)
		)
			throw new IpcError("invalid_metadata");
		return raw as Metadata;
	} catch (error) {
		if (isEnoent(error)) return null;
		if (error instanceof IpcError) throw error;
		if (error instanceof SyntaxError) throw new IpcError("invalid_metadata");
		if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new IpcError("invalid_metadata");
		throw new IpcError("registry_unavailable");
	} finally {
		await handle?.close();
	}
}

function query(meta: Metadata, request: object): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	const socket = net.createConnection({ path: meta.endpoint });
	let buffer = "";
	let bytes = 0;
	let done = false;
	const finish = (error?: Error, response?: Record<string, unknown>): void => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		socket.destroy();
		if (error) reject(error);
		else resolve(response!);
	};
	const timer = setTimeout(() => finish(new IpcError("host_timeout")), TIMEOUT_MS);
	socket.setEncoding("utf8");
	socket.once("connect", () => {
		let frame: string;
		try {
			frame = `${JSON.stringify({ v: VERSION, token: meta.token, ...request })}\n`;
		} catch {
			finish(new IpcError("invalid_request"));
			return;
		}
		if (Buffer.byteLength(frame) > CENTRAL_MAX_FRAME_BYTES) finish(new IpcError("frame_too_large"));
		else socket.end(frame);
	});
	socket.on("data", chunk => {
		if (done) return;
		bytes += Buffer.byteLength(chunk);
		if (bytes > CENTRAL_MAX_FRAME_BYTES) return finish(new IpcError("frame_too_large"));
		buffer += chunk;
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		try {
			const response: unknown = JSON.parse(buffer.slice(0, newline));
			if (!response || typeof response !== "object") throw new Error();
			const payload = response as Record<string, unknown>;
			if (payload.v !== VERSION) return finish(new IpcError("invalid_response"));
			if (payload.ok !== true) {
				const code = [
					"stale_request",
					"invalid_answer",
					"snapshot_unavailable",
					"frame_too_large",
					"unsupported_operation",
					"invalid_request",
					"stale_session",
					"prompt_rejected",
					"request_id_conflict",
					"prompt_capacity",
				].includes(String(payload.error))
					? String(payload.error)
					: "op" in request && (request.op === "workspace" || request.op === "prompt")
						? "unsupported_operation"
						: "request_rejected";
				const error = new IpcError(code);
				return finish(
					"op" in request && request.op === "prompt" && payload.confirmedNoAdmission === true
						? new CentralPromptRejectedError(error.message)
						: error,
				);
			}
			finish(undefined, payload);
		} catch {
			finish(new IpcError("invalid_response"));
		}
	});
	socket.once("error", error => {
		const code = (error as NodeJS.ErrnoException).code;
		finish(new IpcError("host_unavailable", code === "ENOENT" || code === "ECONNREFUSED"));
	});
	socket.once("close", () => finish(new IpcError("host_unavailable")));
	return promise;
}

let publication: Promise<CentralHost> | undefined;

/** One private publication per process, independent of profiles and Collab sharing. */
export function startCentralHost(getState: () => ChatState, options?: Options): Promise<CentralHost> {
	if (publication) return publication;
	const starting = createHost(getState, options).catch(error => {
		if (publication === starting) publication = undefined;
		throw error;
	});
	publication = starting;
	return starting;
}

async function createHost(getState: () => ChatState, options?: Options): Promise<CentralHost> {
	const dir = path.resolve(options?.dir ?? path.join(getBaseConfigRoot(), "run", "central-hosts"));
	await privateDirectory(dir, true);
	const id = crypto.randomUUID();
	const token = crypto.randomBytes(32).toString("hex");
	const tmuxSocket = /^(\/.+),\d+,\d+$/.exec(process.env.TMUX ?? "")?.[1];
	const tmuxPane = process.env.TMUX_PANE;
	const location =
		tmuxSocket && tmuxPane && /^%\d+$/.test(tmuxPane) ? { socket: tmuxSocket, pane: tmuxPane } : undefined;
	let fallbackDir: string | undefined;
	let endpoint = path.join(dir, `${id}.sock`);
	if (process.platform === "win32") endpoint = `\\\\.\\pipe\\omp-central-${id}`;
	else if (Buffer.byteLength(endpoint) >= SUN_PATH_LIMIT) {
		fallbackDir = await fs.promises.mkdtemp("/tmp/omp-central-");
		await fs.promises.chmod(fallbackDir, 0o700);
		endpoint = path.join(fallbackDir, "host.sock");
	}
	const metadataPath = path.join(dir, `${id}.json`);
	const pending = new Map<string, Pending>();
	// Never evict an ID and accidentally admit an old retry again. Once full,
	// refuse new requests; existing IDs remain retryable until this host exits.
	const prompts = new Map<string, { sessionId: string; digest: string; result: Promise<void> }>();
	const sockets = new Set<net.Socket>();
	let closed = false;
	const state = (): ChatState => {
		const current = getState();
		for (const item of pending.values()) {
			if (item.sessionId !== current.sessionId) item.cancel();
		}
		return current;
	};
	const server = net.createServer({ allowHalfOpen: true }, socket => {
		sockets.add(socket);
		socket.unref();
		const timer = setTimeout(() => socket.destroy(), TIMEOUT_MS);
		timer.unref();
		socket.once("close", () => {
			clearTimeout(timer);
			sockets.delete(socket);
		});
		socket.on("error", () => socket.destroy());
		socket.setEncoding("utf8");
		let buffer = "";
		let bytes = 0;
		let handled = false;
		const respond = (payload: object): void => {
			handled = true;
			let frame = `${JSON.stringify({ v: VERSION, ...payload })}\n`;
			if (Buffer.byteLength(frame) > CENTRAL_MAX_FRAME_BYTES)
				frame = `${JSON.stringify({ v: VERSION, ok: false, error: "frame_too_large" })}\n`;
			socket.end(frame);
		};
		socket.on("data", chunk => {
			if (handled) return;
			bytes += Buffer.byteLength(chunk);
			if (bytes > CENTRAL_MAX_FRAME_BYTES) {
				handled = true;
				socket.destroy();
				return;
			}
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			handled = true;
			try {
				const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown> | null;
				if (
					!request ||
					request.v !== VERSION ||
					typeof request.token !== "string" ||
					request.token.length !== token.length ||
					!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(request.token))
				) {
					respond({ ok: false, error: "request_rejected" });
					return;
				}
				const current = state();
				if (closed) return respond({ ok: false, error: "stale_request" });
				if (request.op === "snapshot") {
					respond({
						ok: true,
						chat: {
							...current,
							id,
							pid: process.pid,
							location,
							requests: [...pending.values()].map(item => item.request),
						},
					});
					return;
				}
				if (request.op === "transcript") {
					const transcript = trimTranscriptToBytes(options?.getTranscript?.() ?? []);
					respond({ ok: true, transcript });
					return;
				}
				if (request.op === "workspace") {
					if (!isCentralWorkspaceWidth(request.statusWidth) || !isCentralWorkspaceWidth(request.usageWidth))
						return respond({ ok: false, error: "invalid_request" });
					if (!options?.getWorkspace) return respond({ ok: false, error: "unsupported_operation" });
					const workspace = parseCentralWorkspace(
						options.getWorkspace(request.statusWidth, request.usageWidth),
						request.statusWidth,
						request.usageWidth,
					);
					if (!workspace) return respond({ ok: false, error: "snapshot_unavailable" });
					workspace.canPrompt &&= typeof options.prompt === "function";
					return respond({ ok: true, workspace });
				}
				if (request.op === "prompt") {
					if (!isCentralPrompt(request.sessionId, request.requestId, request.text))
						return respond({ ok: false, error: "invalid_request", confirmedNoAdmission: true });
					const sessionId = request.sessionId as string;
					const requestId = request.requestId as string;
					const text = request.text as string;
					const digest = crypto.createHash("sha256").update(text).digest("hex");
					let entry = prompts.get(requestId);
					if (entry && (entry.sessionId !== sessionId || entry.digest !== digest))
						return respond({ ok: false, error: "request_id_conflict" });
					if (!entry) {
						if (sessionId !== current.sessionId)
							return respond({ ok: false, error: "stale_session", confirmedNoAdmission: true });
						if (!options?.prompt)
							return respond({ ok: false, error: "unsupported_operation", confirmedNoAdmission: true });
						if (prompts.size >= 4_096)
							return respond({ ok: false, error: "prompt_capacity", confirmedNoAdmission: true });
						const pendingPrompt = Promise.withResolvers<void>();
						entry = { sessionId, digest, result: pendingPrompt.promise };
						prompts.set(requestId, entry);
						try {
							options.prompt(sessionId, text).then(pendingPrompt.resolve, pendingPrompt.reject);
						} catch (error) {
							pendingPrompt.reject(error);
						}
					}
					void entry.result.then(
						() => respond({ ok: true }),
						() => respond({ ok: false, error: "prompt_rejected", confirmedNoAdmission: true }),
					);
					return;
				}
				if (request.op !== "answer" || typeof request.requestId !== "string")
					return respond({ ok: false, error: "request_rejected" });
				const item = pending.get(request.requestId);
				if (!item) return respond({ ok: false, error: "stale_request" });
				const answer = validateCentralAnswer(item.request, request.answer);
				if (answer === undefined) return respond({ ok: false, error: "invalid_answer" });
				item.answer(answer);
				respond({ ok: true });
			} catch {
				respond({ ok: false, error: "snapshot_unavailable" });
			}
		});
	});
	const removeArtifacts = (): void => {
		for (const file of [metadataPath, `${metadataPath}.tmp`, ...(process.platform === "win32" ? [] : [endpoint])]) {
			try {
				fs.rmSync(file, { force: true });
			} catch {
				/* Exit cleanup is best effort. */
			}
		}
		if (fallbackDir) {
			try {
				fs.rmdirSync(fallbackDir);
			} catch {
				/* Never recursively remove runtime directories. */
			}
		}
	};
	const hostCloser: { close?: () => void } = {};
	const listening = Promise.withResolvers<void>();
	const onServerError = (): void => {
		listening.reject(new IpcError("startup_failed"));
		hostCloser.close?.();
	};
	server.on("error", onServerError);
	try {
		server.listen(endpoint, () => listening.resolve());
		await listening.promise;
		server.unref();
		if (process.platform !== "win32") await fs.promises.chmod(endpoint, 0o600);
		const meta: Metadata = { v: VERSION, id, pid: process.pid, endpoint, token };
		await fs.promises.writeFile(`${metadataPath}.tmp`, JSON.stringify(meta), { flag: "wx", mode: 0o600 });
		await fs.promises.rename(`${metadataPath}.tmp`, metadataPath);
	} catch {
		server.close();
		for (const socket of sockets) socket.destroy();
		removeArtifacts();
		throw new IpcError("startup_failed");
	}
	process.once("exit", removeArtifacts);
	let closing: Promise<void> | undefined;
	const host: CentralHost = {
		get closed(): boolean {
			return closed;
		},
		race<T extends CentralAnswer | undefined>(
			draft: CentralRequestDraft,
			signal: AbortSignal | undefined,
			local: (signal: AbortSignal) => Promise<T>,
		): Promise<T> {
			if (signal?.aborted) return Promise.resolve(undefined as T);
			const abort = new AbortController();
			if (closed) return local(signal ?? abort.signal);
			const current = state();
			if (!isCentralRequestDraft(draft)) return Promise.reject(new IpcError("invalid_request"));
			const request: CentralRequest = { ...structuredClone(draft), id: crypto.randomUUID(), createdAt: Date.now() };
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			let settled = false;
			const finish = (value: T, failure?: { error: unknown }): void => {
				if (settled) return;
				settled = true;
				pending.delete(request.id);
				signal?.removeEventListener("abort", cancel);
				if (failure) reject(failure.error);
				else resolve(value);
				abort.abort();
			};
			const cancel = (): void => finish(undefined as T);
			pending.set(request.id, {
				request,
				sessionId: current.sessionId,
				answer: value => finish(value as T),
				cancel,
			});
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				local(abort.signal).then(
					value => finish(value),
					error => finish(undefined as T, { error }),
				);
			} catch (error) {
				finish(undefined as T, { error });
			}
			return promise;
		},
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			publication = undefined;
			process.off("exit", removeArtifacts);
			// A transport failure must not turn a live local dialog into a cancel.
			// Drop discovery entries and pending IPC correlations, but leave each
			// local race's abort signal untouched so the local UI can finish.
			pending.clear();
			options?.onClosed?.();
			const done = Promise.withResolvers<void>();
			closing = done.promise;
			server.close(() => done.resolve());
			for (const socket of sockets) socket.destroy();
			removeArtifacts();
			return closing;
		},
	};
	hostCloser.close = () => void host.close();
	return host;
}

/** Dead endpoints are pruned; an unresponsive live endpoint fails visibly, never masquerades as an empty queue. */
export async function listCentralChats(options?: Options): Promise<CentralChat[]> {
	const dir = path.resolve(options?.dir ?? path.join(getBaseConfigRoot(), "run", "central-hosts"));
	try {
		await privateDirectory(dir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const names = (await fs.promises.readdir(dir)).filter(name => name.endsWith(".json")).sort();
	const chats: CentralChat[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < names.length) {
			const name = names[next++]!;
			const meta = await readMetadata(dir, name.slice(0, -5));
			if (!meta) continue;
			try {
				const response = await query(meta, { op: "snapshot" });
				const chat = parseCentralChat(response.chat);
				if (!chat || chat.id !== meta.id || chat.pid !== meta.pid) throw new IpcError("invalid_response");
				chats.push(chat);
			} catch (error) {
				if (!(error instanceof IpcError) || !error.dead) throw error;
				await fs.promises.rm(path.join(dir, name), { force: true });
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(8, names.length) }, worker));
	return chats.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getCentralChatTranscript(chatId: string, options?: Options): Promise<TranscriptEntryLike[]> {
	const dir = path.resolve(options?.dir ?? path.join(getBaseConfigRoot(), "run", "central-hosts"));
	await privateDirectory(dir);
	const meta = await readMetadata(dir, chatId);
	if (!meta) throw new IpcError("host_unavailable");
	const response = await query(meta, { op: "transcript" });
	if (!Array.isArray(response.transcript)) throw new IpcError("invalid_response");
	return response.transcript as TranscriptEntryLike[];
}

export async function answerCentralQuestion(
	chatId: string,
	requestId: string,
	answer: CentralAnswer,
	options?: Options,
): Promise<void> {
	const dir = path.resolve(options?.dir ?? path.join(getBaseConfigRoot(), "run", "central-hosts"));
	try {
		await privateDirectory(dir);
	} catch {
		throw new IpcError("host_unavailable");
	}
	const meta = await readMetadata(dir, chatId);
	if (!meta) throw new IpcError("host_unavailable");
	await query(meta, { op: "answer", requestId, answer });
}

export async function getCentralChatWorkspace(
	chatId: string,
	statusWidth: number,
	usageWidth: number,
	options?: Options,
): Promise<CentralWorkspace> {
	if (!isCentralWorkspaceWidth(statusWidth) || !isCentralWorkspaceWidth(usageWidth))
		throw new IpcError("invalid_request");
	const dir = path.resolve(options?.dir ?? path.join(getBaseConfigRoot(), "run", "central-hosts"));
	await privateDirectory(dir);
	const meta = await readMetadata(dir, chatId);
	if (!meta) throw new IpcError("host_unavailable");
	const response = await query(meta, { op: "workspace", statusWidth, usageWidth });
	const workspace = parseCentralWorkspace(response.workspace, statusWidth, usageWidth);
	if (!workspace) throw new IpcError("invalid_response");
	return workspace;
}

export async function promptCentralChat(
	chatId: string,
	sessionId: string,
	requestId: string,
	text: string,
	options?: Options,
): Promise<void> {
	if (!isCentralPrompt(sessionId, requestId, text))
		throw new CentralPromptRejectedError("OMP Central: invalid_request");
	const dir = path.resolve(options?.dir ?? path.join(getBaseConfigRoot(), "run", "central-hosts"));
	await privateDirectory(dir);
	const meta = await readMetadata(dir, chatId);
	if (!meta) throw new IpcError("host_unavailable");
	// No automatic retry: only the caller may retry, with this same request ID.
	await query(meta, { op: "prompt", sessionId, requestId, text });
}
