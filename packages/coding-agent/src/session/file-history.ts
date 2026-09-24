/**
 * Per-session file history behind code-restoring rewind.
 *
 * A checkpoint is the user prompt that started an agent run. Before a file
 * editing tool first changes a path during a checkpoint, the file's prior
 * bytes (or its absence) are saved once. Restoring to a checkpoint puts every
 * path touched at or after it back to the state recorded the first time any
 * later-or-equal checkpoint touched it — the file as it was when that prompt
 * was sent. Checkpoints are ordered by when they were created, not by session
 * tree position, because the workspace has one linear history even when the
 * conversation branches.
 *
 * Persistent sessions keep `index.jsonl` plus content-addressed snapshots in
 * `<session artifacts>/file-history/`, so rewind works after resume. Sessions
 * without an artifacts directory keep the same data in memory.
 *
 * Bash, external editors, and other sessions are not tracked; symlinked and
 * hard-linked paths are skipped at restore time rather than written through.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { invalidateFsScanAfterDelete, invalidateFsScanAfterWrite } from "../tools/fs-cache-invalidation";

/** Checkpoints kept per session; older ones and their unreferenced snapshots are dropped. */
export const FILE_HISTORY_MAX_CHECKPOINTS = 100;

const INDEX_FILE = "index.jsonl";

/** A path's state before the first tracked change within one checkpoint. */
interface FileRecord {
	checkpoint: string;
	path: string;
	/** Snapshot hash of the prior bytes, or `null` when the file did not exist. */
	before: string | null;
	mode?: number;
}

type IndexLine = { t: "checkpoint"; id: string } | ({ t: "file" } & FileRecord);

interface HistoryState {
	/** Snapshot directory; `null` keeps snapshots in {@link blobs}. */
	dir: string | null;
	checkpoints: string[];
	records: FileRecord[];
	/** `${checkpoint}\0${path}` → capture in flight or done; dedupes concurrent first writes. */
	captures: Map<string, Promise<void>>;
	blobs: Map<string, Uint8Array>;
	current: string | undefined;
	/** Serializes index appends and rewrites. */
	writeTail: Promise<void>;
}

/** One file a restore would change. */
export interface FileRestoreTarget {
	path: string;
	/** `null` means the file did not exist at the checkpoint and will be deleted. */
	before: string | null;
	mode?: number;
}

export interface FileRestoreResult {
	/** Paths written back or deleted. */
	restored: string[];
	/** Symlinked or hard-linked paths left untouched. */
	skipped: string[];
	/** Paths whose snapshot could not be read. */
	failed: string[];
}

/** A file's full contents (or absence) and permission bits. */
interface FileState {
	path: string;
	/** `null` means the file does not exist. */
	bytes: Uint8Array | null;
	mode?: number;
}

/** Where a session's history lives; satisfied by `SessionManager`. */
export interface FileHistoryOwner {
	getArtifactsDir(): string | null;
	getSessionId(): string;
}

export class FileHistory {
	readonly #owner: FileHistoryOwner;
	readonly #maxCheckpoints: number;
	#state: Promise<HistoryState> | undefined;
	#stateKey: string | undefined;
	/** Last checkpoint registration; captures wait for it so they attribute to the new prompt. */
	#beginTail: Promise<void> = Promise.resolve();
	/** What the last restore overwrote, until the next agent run or a session switch. */
	#undo: { key: string; files: FileState[] } | undefined;

	constructor(owner: FileHistoryOwner, options: { maxCheckpoints?: number } = {}) {
		this.#owner = owner;
		this.#maxCheckpoints = options.maxCheckpoints ?? FILE_HISTORY_MAX_CHECKPOINTS;
	}

	/** Start a checkpoint for the user prompt entry that began an agent run. */
	beginCheckpoint(entryId: string): Promise<void> {
		const begin = this.#beginTail.then(async () => {
			const state = await this.#load();
			if (state.checkpoints.includes(entryId)) {
				state.current = entryId;
				return;
			}
			state.checkpoints.push(entryId);
			state.current = entryId;
			if (state.checkpoints.length > this.#maxCheckpoints) {
				await this.#prune(state);
			} else {
				await this.#append(state, [{ t: "checkpoint", id: entryId }]);
			}
		});
		this.#beginTail = begin.catch(error => {
			logger.debug("file history: checkpoint registration failed", { error: String(error) });
		});
		return this.#beginTail;
	}

	/**
	 * Save `filePath`'s current state before a tool changes it. Only the first
	 * call per path within a checkpoint captures; concurrent callers share that
	 * capture, so parallel edits of one file never snapshot a half-applied state.
	 * Never throws: a failed capture is logged and the edit proceeds untracked.
	 */
	async recordBeforeMutation(filePath: string): Promise<void> {
		await this.#beginTail;
		let state: HistoryState;
		try {
			state = await this.#load();
		} catch (error) {
			logger.debug("file history: load failed", { error: String(error) });
			return;
		}
		const checkpoint = state.current;
		if (!checkpoint) return;
		const resolved = path.resolve(filePath);
		const key = `${checkpoint}\0${resolved}`;
		let capture = state.captures.get(key);
		if (!capture) {
			capture = this.#capture(state, checkpoint, resolved).catch(error => {
				logger.debug("file history: capture failed", { path: resolved, error: String(error) });
			});
			state.captures.set(key, capture);
		}
		await capture;
	}

	/** Files whose current state differs from their state when checkpoint `entryId` began. */
	async planRestore(entryId: string): Promise<FileRestoreTarget[]> {
		await this.#beginTail;
		const state = await this.#load();
		await Promise.all(state.captures.values());
		const order = state.checkpoints.indexOf(entryId);
		if (order === -1) return [];
		const later = new Set(state.checkpoints.slice(order));
		const targets = new Map<string, FileRecord>();
		for (const record of state.records) {
			if (later.has(record.checkpoint) && !targets.has(record.path)) targets.set(record.path, record);
		}
		const changed: FileRestoreTarget[] = [];
		for (const record of targets.values()) {
			const current = await readCurrent(record.path);
			const currentHash = current === null ? null : hashBytes(current);
			if (currentHash === record.before) continue;
			changed.push({ path: record.path, before: record.before, mode: record.mode });
		}
		return changed;
	}

	/**
	 * Put every file changed since checkpoint `entryId` back to its state when
	 * that prompt was sent. The versions it overwrites are kept so
	 * {@link undoRestore} can put them back until {@link dropUndo}.
	 */
	async restore(entryId: string): Promise<FileRestoreResult> {
		const state = await this.#load();
		const result: FileRestoreResult = { restored: [], skipped: [], failed: [] };
		const overwritten: FileState[] = [];
		for (const target of await this.planRestore(entryId)) {
			let bytes: Uint8Array | null = null;
			if (target.before !== null) {
				try {
					bytes = await this.#readSnapshot(state, target.before);
				} catch (error) {
					logger.debug("file history: snapshot missing", { path: target.path, error: String(error) });
					result.failed.push(target.path);
					continue;
				}
			}
			const previous = await putFile({ path: target.path, bytes, mode: target.mode }, result);
			if (previous) overwritten.push(previous);
		}
		if (overwritten.length > 0) this.#undo = { key: this.#key(), files: overwritten };
		return result;
	}

	/** Whether the last restore can still be undone. */
	get canUndoRestore(): boolean {
		return this.#undo !== undefined && this.#undo.key === this.#key();
	}

	/** Put back the files the last restore overwrote. Only once; later calls do nothing. */
	async undoRestore(): Promise<FileRestoreResult> {
		const result: FileRestoreResult = { restored: [], skipped: [], failed: [] };
		const undo = this.#undo;
		this.#undo = undefined;
		if (!undo || undo.key !== this.#key()) return result;
		for (const file of undo.files) await putFile(file, result);
		return result;
	}

	/** Forget the last restore's overwritten files; called when a new agent run starts. */
	dropUndo(): void {
		this.#undo = undefined;
	}

	#key(): string {
		return this.#owner.getArtifactsDir() ?? `memory:${this.#owner.getSessionId()}`;
	}

	#load(): Promise<HistoryState> {
		const dirRoot = this.#owner.getArtifactsDir();
		const key = this.#key();
		if (this.#state && this.#stateKey === key) return this.#state;
		this.#stateKey = key;
		const dir = dirRoot ? path.join(dirRoot, "file-history") : null;
		this.#state = readState(dir);
		// A failed load must not poison later attempts.
		this.#state.catch(() => {
			if (this.#stateKey === key) {
				this.#state = undefined;
				this.#stateKey = undefined;
			}
		});
		return this.#state;
	}

	async #capture(state: HistoryState, checkpoint: string, filePath: string): Promise<void> {
		let stat: Stats | undefined;
		try {
			stat = await fs.stat(filePath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (stat && !stat.isFile()) return;
		let record: FileRecord;
		if (!stat) {
			record = { checkpoint, path: filePath, before: null };
		} else {
			const bytes = await Bun.file(filePath).bytes();
			const hash = hashBytes(bytes);
			await this.#writeSnapshot(state, hash, bytes);
			record = { checkpoint, path: filePath, before: hash, mode: stat.mode & 0o7777 };
		}
		// A prune may have dropped this checkpoint while the capture ran.
		if (!state.checkpoints.includes(checkpoint)) return;
		state.records.push(record);
		await this.#append(state, [{ t: "file", ...record }]);
	}

	async #writeSnapshot(state: HistoryState, hash: string, bytes: Uint8Array): Promise<void> {
		if (!state.dir) {
			state.blobs.set(hash, bytes);
			return;
		}
		const target = path.join(state.dir, hash);
		if (await Bun.file(target).exists()) return;
		await fs.mkdir(state.dir, { recursive: true });
		const temp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		await Bun.write(temp, bytes);
		await fs.rename(temp, target);
	}

	async #readSnapshot(state: HistoryState, hash: string): Promise<Uint8Array> {
		if (!state.dir) {
			const bytes = state.blobs.get(hash);
			if (!bytes) throw new Error(`file history snapshot ${hash} is missing`);
			return bytes;
		}
		return Bun.file(path.join(state.dir, hash)).bytes();
	}

	#append(state: HistoryState, lines: IndexLine[]): Promise<void> {
		const dir = state.dir;
		if (!dir) return Promise.resolve();
		const text = lines.map(line => `${JSON.stringify(line)}\n`).join("");
		const next = state.writeTail.then(async () => {
			await fs.mkdir(dir, { recursive: true });
			await fs.appendFile(path.join(dir, INDEX_FILE), text);
		});
		state.writeTail = next.catch(error => {
			logger.debug("file history: index append failed", { error: String(error) });
		});
		return state.writeTail;
	}

	/** Drop the oldest checkpoints beyond the cap, rewrite the index, and delete orphaned snapshots. */
	async #prune(state: HistoryState): Promise<void> {
		const dropped = new Set(state.checkpoints.splice(0, state.checkpoints.length - this.#maxCheckpoints));
		state.records = state.records.filter(record => !dropped.has(record.checkpoint));
		for (const key of [...state.captures.keys()]) {
			if (dropped.has(key.slice(0, key.indexOf("\0")))) state.captures.delete(key);
		}
		const live = new Set(state.records.map(record => record.before).filter((hash): hash is string => hash !== null));
		if (!state.dir) {
			for (const hash of [...state.blobs.keys()]) if (!live.has(hash)) state.blobs.delete(hash);
			return;
		}
		const dir = state.dir;
		const lines: IndexLine[] = [];
		const byCheckpoint = new Map<string, FileRecord[]>();
		for (const record of state.records) {
			const list = byCheckpoint.get(record.checkpoint);
			if (list) list.push(record);
			else byCheckpoint.set(record.checkpoint, [record]);
		}
		for (const id of state.checkpoints) {
			lines.push({ t: "checkpoint", id });
			for (const record of byCheckpoint.get(id) ?? []) lines.push({ t: "file", ...record });
		}
		const next = state.writeTail.then(async () => {
			await fs.mkdir(dir, { recursive: true });
			const indexPath = path.join(dir, INDEX_FILE);
			const temp = `${indexPath}.tmp-${process.pid}`;
			await Bun.write(temp, lines.map(line => `${JSON.stringify(line)}\n`).join(""));
			await fs.rename(temp, indexPath);
			for (const name of await fs.readdir(dir)) {
				if (name === INDEX_FILE || name.includes(".tmp-") || live.has(name)) continue;
				await fs.rm(path.join(dir, name), { force: true });
			}
		});
		state.writeTail = next.catch(error => {
			logger.debug("file history: prune failed", { error: String(error) });
		});
		await state.writeTail;
	}
}

async function readState(dir: string | null): Promise<HistoryState> {
	const state: HistoryState = {
		dir,
		checkpoints: [],
		records: [],
		captures: new Map(),
		blobs: new Map(),
		current: undefined,
		writeTail: Promise.resolve(),
	};
	if (!dir) return state;
	let text: string;
	try {
		text = await Bun.file(path.join(dir, INDEX_FILE)).text();
	} catch (error) {
		if (isEnoent(error)) return state;
		throw error;
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: IndexLine;
		try {
			parsed = JSON.parse(line) as IndexLine;
		} catch {
			// A torn trailing append from a crash; everything before it is intact.
			continue;
		}
		if (parsed.t === "checkpoint") {
			if (!state.checkpoints.includes(parsed.id)) state.checkpoints.push(parsed.id);
		} else if (parsed.t === "file") {
			const record: FileRecord = {
				checkpoint: parsed.checkpoint,
				path: parsed.path,
				before: parsed.before,
				...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
			};
			state.records.push(record);
			state.captures.set(`${record.checkpoint}\0${record.path}`, Promise.resolve());
		}
	}
	state.current = state.checkpoints.at(-1);
	return state;
}

/**
 * Make `target.path` hold `target.bytes` (or not exist), recording the outcome
 * in `result`. Symlinked, hard-linked, and non-regular paths are skipped rather
 * than written through. Returns the state it replaced, or `undefined` when
 * nothing changed.
 */
async function putFile(target: FileState, result: FileRestoreResult): Promise<FileState | undefined> {
	let stat: Stats | undefined;
	try {
		stat = await fs.lstat(target.path);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (stat && (!stat.isFile() || stat.nlink > 1)) {
		result.skipped.push(target.path);
		return undefined;
	}
	try {
		const previous: FileState = stat
			? { path: target.path, bytes: await Bun.file(target.path).bytes(), mode: stat.mode & 0o7777 }
			: { path: target.path, bytes: null };
		if (target.bytes === null) {
			if (stat) await fs.rm(target.path);
			invalidateFsScanAfterDelete(target.path);
		} else {
			await fs.mkdir(path.dirname(target.path), { recursive: true });
			await Bun.write(target.path, target.bytes);
			if (target.mode !== undefined) await fs.chmod(target.path, target.mode);
			invalidateFsScanAfterWrite(target.path);
		}
		result.restored.push(target.path);
		return previous;
	} catch (error) {
		logger.debug("file history: restore failed", { path: target.path, error: String(error) });
		result.failed.push(target.path);
		return undefined;
	}
}

async function readCurrent(filePath: string): Promise<Uint8Array | null> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) return null;
		return await Bun.file(filePath).bytes();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

function hashBytes(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
