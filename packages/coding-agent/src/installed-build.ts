import * as fs from "node:fs";
import { isCompiledBinary } from "@oh-my-pi/pi-utils";

/** File identity of an installed executable; an atomic install swaps in a new inode. */
export interface BinaryIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
}

export function readBinaryIdentity(executablePath: string): BinaryIdentity | undefined {
	try {
		const stat = fs.statSync(executablePath);
		if (!stat.isFile() || stat.size === 0 || (stat.mode & 0o111) === 0) return undefined;
		return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
	} catch {
		return undefined;
	}
}

export function sameIdentity(a: BinaryIdentity, b: BinaryIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** The running compiled executable; undefined for source/SDK launches, which have no installed binary. */
export function runningExecutablePath(): string | undefined {
	if (!isCompiledBinary()) return undefined;
	// Linux reports a replaced executable as "<path> (deleted)".
	return process.execPath.replace(/ \(deleted\)$/, "");
}

/**
 * Reports when a different build has been installed over the running
 * executable. The new file must be seen unchanged on two checks at least
 * `intervalMs` apart, so a file still being written is never launched.
 */
export class InstalledBuildWatcher {
	readonly #path: string | undefined;
	readonly #startup: BinaryIdentity | undefined;
	readonly #intervalMs: number;
	readonly #now: () => number;
	#checkedAt = Number.NEGATIVE_INFINITY;
	#candidate: BinaryIdentity | undefined;
	#ready = false;

	constructor(executablePath: string | undefined, options: { intervalMs?: number; now?: () => number } = {}) {
		this.#path = executablePath;
		this.#startup = executablePath ? readBinaryIdentity(executablePath) : undefined;
		this.#intervalMs = options.intervalMs ?? 15_000;
		this.#now = options.now ?? Date.now;
	}

	/** Cheap to call often: the file is examined at most once per interval. */
	ready(): boolean {
		if (this.#ready) return true;
		if (!this.#path || !this.#startup) return false;
		const now = this.#now();
		if (now - this.#checkedAt < this.#intervalMs) return false;
		this.#checkedAt = now;
		const current = readBinaryIdentity(this.#path);
		if (!current || sameIdentity(current, this.#startup)) {
			this.#candidate = undefined;
			return false;
		}
		if (this.#candidate && sameIdentity(this.#candidate, current)) this.#ready = true;
		else this.#candidate = current;
		return this.#ready;
	}
}
