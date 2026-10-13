import { closeSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { encodeKittyPlaceholderCells, encodeKittyVirtualPlacement } from "../kitty-graphics";
import { encodeKittyDeleteImage, encodeKittyTransmit } from "../terminal-capabilities";
import { isInsideTmux } from "../tmux";
import { RAVENS_LOGO_PNG_BASE64 } from "./ravens-logo-data";

export interface RavensHeaderTransport {
	readonly replayDir: string;
	probe(): Promise<{ enabled: boolean; inMode: boolean } | undefined>;
	publish(header: string, file: string): boolean;
	clear(file: string): void;
}

const SAFE_PATH = /^[A-Za-z0-9_./+-]+$/;
const TIMEOUT_MS = 500;

/** Local tmux IPC only; no shell is involved in passing the header or file name. */
export class TmuxRavensHeaderTransport implements RavensHeaderTransport {
	constructor(
		readonly tmuxPath: string,
		readonly pane: string,
		readonly env: NodeJS.ProcessEnv,
		readonly replayDir: string,
	) {}

	async probe(): Promise<{ enabled: boolean; inMode: boolean } | undefined> {
		try {
			const child = Bun.spawn(
				[
					this.tmuxPath,
					"display-message",
					"-p",
					"-t",
					this.pane,
					"#{@omp-ravens-header-enabled}|#{pane-border-status}|#{pane_in_mode}",
				],
				{
					env: this.env,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "ignore",
					timeout: TIMEOUT_MS,
					killSignal: "SIGKILL",
				},
			);
			const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			if (code !== 0) return undefined;
			const [enabled, position, inMode] = output.trim().split("|");
			if (inMode !== "0" && inMode !== "1") return undefined;
			return { enabled: enabled === "1" && position === "top", inMode: inMode === "1" };
		} catch {
			return undefined;
		}
	}

	#run(args: string[]): boolean {
		try {
			return (
				Bun.spawnSync([this.tmuxPath, ...args], {
					env: this.env,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					timeout: TIMEOUT_MS,
					killSignal: "SIGKILL",
				}).exitCode === 0
			);
		} catch {
			return false;
		}
	}

	publish(header: string, file: string): boolean {
		if (!SAFE_PATH.test(file) || !/^%\d+$/.test(this.pane)) return false;
		return this.#run([
			"set-option",
			"-p",
			"-t",
			this.pane,
			"@omp-ravens-kitty-file",
			file,
			";",
			"set-option",
			"-p",
			"-t",
			this.pane,
			"@omp-ravens-header",
			header,
			";",
			// Pane passthrough is dropped in copy mode. The opt-in config installs
			// this same replay helper for reconnects and window switches.
			"run-shell",
			"-b",
			"-t",
			this.pane,
			"python3 ~/.config/tmux/ravens-header.py replay #{q:session_id}",
		]);
	}

	clear(file: string): void {
		if (!SAFE_PATH.test(file) || !/^%\d+$/.test(this.pane)) return;
		this.#run([
			"if-shell",
			"-F",
			"-t",
			this.pane,
			`#{==:#{@omp-ravens-kitty-file},${file}}`,
			`set-option -pu -t ${this.pane} @omp-ravens-header ; set-option -pu -t ${this.pane} @omp-ravens-kitty-file`,
		]);
	}
}

export function resolveRavensHeaderTransport(env: NodeJS.ProcessEnv = Bun.env): RavensHeaderTransport | undefined {
	if (!isInsideTmux(env) || isBunTestRuntime() || !/^%\d+$/.test(env.TMUX_PANE ?? "")) return undefined;
	const tmux = $which("tmux", { PATH: env.PATH });
	const uid = process.getuid?.();
	if (!tmux || uid === undefined) return undefined;
	const replayDir = env.XDG_RUNTIME_DIR
		? join(env.XDG_RUNTIME_DIR, "omp-ravens")
		: join(tmpdir(), `omp-ravens-${uid}`);
	return new TmuxRavensHeaderTransport(tmux, env.TMUX_PANE!, env, replayDir);
}

function removeFile(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		/* Already removed or inaccessible during shutdown. */
	}
}

/** Owns one stable image and one pane receipt. All probes are async and bounded. */
export class RavensHeader {
	mode: "pending" | "inline" | "header" = "pending";
	#wanted: number | undefined;
	#published: { columns: number; file: string } | undefined;
	#busy = true;
	#closed = false;
	#failures = 0;
	#generation = 0;

	constructor(
		readonly transport: RavensHeaderTransport,
		readonly imageId: number,
		readonly onChange: () => void,
		readonly emit: (bytes: string) => void,
	) {
		void this.#activate();
	}

	async #activate(): Promise<void> {
		let enabled = false;
		try {
			enabled = (await this.transport.probe())?.enabled === true;
		} catch {
			/* Inline fallback. */
		}
		if (this.#closed) return;
		this.mode = enabled ? "header" : "inline";
		this.#busy = false;
		this.onChange();
	}

	sync(columns: number | undefined): void {
		this.#wanted = columns;
		if (this.#closed || this.mode !== "header" || this.#busy || columns === this.#published?.columns) return;
		this.#busy = true;
		void this.#sync();
	}

	#clear(): void {
		if (!this.#published) return;
		const { file } = this.#published;
		this.transport.clear(file);
		removeFile(file);
		this.#published = undefined;
	}

	async #sync(): Promise<void> {
		let file: string | undefined;
		try {
			const state = await this.transport.probe();
			if (this.#closed) return;
			if (!state) throw new Error("tmux unavailable");
			if (!state.enabled) {
				this.#clear();
				this.mode = "inline";
				return;
			}
			const columns = this.#wanted;
			if (columns === undefined) {
				this.#clear();
				return;
			}
			const dir = this.transport.replayDir;
			if (!isAbsolute(dir) || !SAFE_PATH.test(dir)) throw new Error("Unsafe replay path");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const info = lstatSync(dir);
			if (
				!info.isDirectory() ||
				info.isSymbolicLink() ||
				info.uid !== process.getuid?.() ||
				(info.mode & 0o077) !== 0
			) {
				throw new Error("Unsafe replay directory");
			}
			const placement = { imageId: this.imageId, placementId: this.imageId, columns, rows: 1 };
			const raw =
				encodeKittyTransmit(RAVENS_LOGO_PNG_BASE64, this.imageId, false) +
				encodeKittyVirtualPlacement({ ...placement, passthrough: false });
			const candidate = join(dir, `${process.pid}-${this.imageId}-${++this.#generation}.apc`);
			const fd = openSync(candidate, "wx", 0o600);
			file = candidate;
			try {
				writeFileSync(fd, raw);
			} finally {
				closeSync(fd);
			}
			if (!state.inMode) {
				this.emit(
					encodeKittyTransmit(RAVENS_LOGO_PNG_BASE64, this.imageId, true) +
						encodeKittyVirtualPlacement({ ...placement, passthrough: true }),
				);
			}
			const color = this.imageId.toString(16).padStart(6, "0");
			const header = `#[fg=#${color},us=#${color}]${encodeKittyPlaceholderCells(0, columns)}`;
			if (!this.transport.publish(header, file)) throw new Error("tmux publish failed");
			const previous = this.#published;
			this.#published = { columns, file };
			file = undefined;
			if (previous) removeFile(previous.file);
			this.#failures = 0;
		} catch {
			if (file) {
				this.transport.clear(file);
				removeFile(file);
			}
			if (!this.#closed && ++this.#failures >= 3) {
				this.#clear();
				this.mode = "inline";
			}
		} finally {
			this.#busy = false;
			// At most three failed attempts, driven by redraws, never an idle timer.
			if (!this.#closed) this.onChange();
		}
	}

	release(): string {
		if (this.#closed) return "";
		this.#closed = true;
		const hadImage = this.#published !== undefined;
		this.#clear();
		return hadImage ? encodeKittyDeleteImage(this.imageId) : "";
	}
}
