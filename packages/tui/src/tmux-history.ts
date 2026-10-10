import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";

export interface TmuxHistorySnapshot {
	owners: readonly (object | undefined)[];
	screenTop: number;
	columns: number;
	rows: number;
	release(): void;
	valid(): boolean;
}

export interface TmuxHistoryHost {
	capture(owner?: object): Promise<TmuxHistorySnapshot | undefined>;
	setHistoryLimit(limit: number): void;
}

interface HistoryRequest {
	op: "wheel" | "click";
	pane: string;
	generation: number;
	token?: string;
	x?: number;
	y?: number;
	scroll?: number;
	columns?: number;
	rows?: number;
}

interface PaneState {
	mode: boolean;
	scrollback: boolean;
	generation: number;
	token: string;
	columns: number;
	rows: number;
	scroll: number;
	historyLimit: number;
	socket: string;
}

const execute = promisify(execFile);
const STATE_FORMAT =
	"#{pane_in_mode}\t#{@scrollback}\t#{@omp-history-generation}\t#{@omp-history-snapshot}\t#{pane_width}\t#{pane_height}\t#{scroll_position}\t#{history_limit}\t#{@omp-history-socket}";

/** Native tmux history owns scrolling/selection; only immutable row identities cross this socket. */
export class TmuxHistoryBridge {
	#server: Server;
	#clients = new Set<Socket>();
	#stopped = false;
	#queue: Promise<void> = Promise.resolve();
	#pending = 0;
	#snapshot?: { value: TmuxHistorySnapshot; token: string; generation: number };
	#sequence = 0;

	private constructor(
		private readonly host: TmuxHistoryHost,
		private readonly serverSocket: string,
		private readonly pane: string,
		private readonly directory: string,
		private readonly socketPath: string,
	) {
		this.#server = createServer(socket => this.#connect(socket));
		this.#server.maxConnections = 32;
		this.#server.on("error", () => this.stop());
	}

	static async create(host: TmuxHistoryHost): Promise<TmuxHistoryBridge | undefined> {
		if (isBunTestRuntime()) return undefined;
		const serverSocket = /^(.*),\d+,\d+$/.exec(process.env.TMUX ?? "")?.[1];
		const pane = process.env.TMUX_PANE;
		if (!serverSocket || !pane || !/^%\d+$/.test(pane)) return undefined;
		let bridge: TmuxHistoryBridge | undefined;
		let directory: string | undefined;
		try {
			directory = await mkdtemp(join(tmpdir(), "omp-h-"));
			await chmod(directory, 0o700);
			bridge = new TmuxHistoryBridge(host, serverSocket, pane, directory, join(directory, "s"));
			await new Promise<void>((resolve, reject) => {
				bridge!.#server.once("error", reject);
				bridge!.#server.listen(bridge!.socketPath, () => {
					bridge!.#server.removeListener("error", reject);
					resolve();
				});
			});
			await chmod(bridge.socketPath, 0o600);
			const state = await bridge.#state();
			if (
				!Number.isSafeInteger(state.historyLimit) ||
				state.historyLimit < 0 ||
				!Number.isSafeInteger(state.columns) ||
				state.columns <= 0 ||
				!Number.isSafeInteger(state.rows) ||
				state.rows <= 0 ||
				!Number.isSafeInteger(state.historyLimit + state.rows)
			)
				throw new Error("Invalid tmux pane dimensions");
			host.setHistoryLimit(state.historyLimit + state.rows);
			await bridge.#tmux("set", "-p", "-t", pane, "@omp-history-socket", bridge.socketPath);
			return bridge;
		} catch {
			if (bridge) bridge.stop();
			else if (directory) await rm(directory, { recursive: true, force: true });
			return undefined;
		}
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#snapshot = undefined;
		for (const client of this.#clients) client.destroy();
		this.#server.close();
		void this.#tmux(
			"if",
			"-F",
			"-t",
			this.pane,
			`#{==:#{@omp-history-socket},${this.socketPath}}`,
			`set -pu -t ${this.pane} @omp-history-socket ; set -pu -t ${this.pane} @omp-history-snapshot`,
		)
			.catch(() => {})
			.finally(() => rm(this.directory, { recursive: true, force: true }).catch(() => {}));
	}

	async #tmux(...args: string[]): Promise<string> {
		const { stdout } = await execute("tmux", ["-S", this.serverSocket, ...args], { timeout: 2000, maxBuffer: 8192 });
		return stdout.trim();
	}

	async #state(): Promise<PaneState> {
		const values = (await this.#tmux("display", "-p", "-t", this.pane, STATE_FORMAT)).split("\t");
		return {
			mode: values[0] === "1",
			scrollback: values[1] === "1",
			generation: Number(values[2] || 0),
			token: values[3] ?? "",
			columns: Number(values[4]),
			rows: Number(values[5]),
			scroll: Number(values[6] || 0),
			historyLimit: Number(values[7]),
			socket: values[8] ?? "",
		};
	}

	#connect(socket: Socket): void {
		this.#clients.add(socket);
		socket.setEncoding("utf8");
		socket.setTimeout(5000, () => socket.destroy());
		socket.on("error", () => {});
		socket.on("close", () => this.#clients.delete(socket));
		let input = "";
		let received = false;
		socket.on("data", chunk => {
			if (received) return;
			input += chunk;
			if (input.length > 2048) {
				socket.destroy();
				return;
			}
			if (!input.includes("\n")) return;
			received = true;
			let request: HistoryRequest;
			try {
				request = JSON.parse(input.slice(0, input.indexOf("\n")));
			} catch {
				socket.end('{"ok":false}\n');
				return;
			}
			if (
				!request ||
				request.pane !== this.pane ||
				!Number.isSafeInteger(request.generation) ||
				(request.op !== "wheel" && request.op !== "click") ||
				this.#stopped
			) {
				socket.end('{"ok":false}\n');
				return;
			}
			// Bound bursts without letting a late fallback create an unowned snapshot.
			if (this.#pending >= 32) {
				socket.end('{"ok":true}\n');
				return;
			}
			this.#pending++;
			this.#queue = this.#queue.then(async () => {
				let ok = false;
				try {
					if (!this.#stopped) ok = await this.#handle(request);
				} catch {
					/* A failed fence or dead pane never resolves a guessed owner. */
				} finally {
					this.#pending--;
					socket.end(`${JSON.stringify({ ok })}\n`);
				}
			});
		});
	}

	#guard(state: PaneState, token = state.token): string {
		const clauses = [
			`#{==:#{@omp-history-socket},${this.socketPath}}`,
			`#{==:#{@omp-history-generation},${state.generation}}`,
			`#{==:#{pane_in_mode},${state.mode ? 1 : 0}}`,
			`#{==:#{pane_width},${state.columns}}`,
			`#{==:#{pane_height},${state.rows}}`,
			"#{==:#{alternate_on},0}",
		];
		if (state.mode) clauses.push("#{==:#{@scrollback},1}", `#{==:#{@omp-history-snapshot},${token}}`);
		return clauses.reduce((left, right) => `#{&&:${left},${right}}`);
	}

	async #handle(request: HistoryRequest): Promise<boolean> {
		const state = await this.#state();
		if (state.socket !== this.socketPath || this.#stopped) return false;
		if (request.op === "wheel") {
			// Wheel requests captured before entry can arrive after its mode-change hook.
			if (state.mode) {
				if (
					!state.scrollback ||
					!this.#snapshot ||
					state.token !== this.#snapshot.token ||
					state.generation !== this.#snapshot.generation ||
					(request.generation !== state.generation && request.generation + 1 !== state.generation)
				)
					return true;
				await this.#tmux("if", "-F", "-t", this.pane, this.#guard(state), `send -t ${this.pane} -X -N 3 scroll-up`);
				return true;
			}
			if (state.generation !== request.generation) return true;
			return this.#enter(state);
		}
		const saved = this.#snapshot;
		if (
			!saved ||
			!state.mode ||
			!state.scrollback ||
			state.generation !== request.generation ||
			state.generation !== saved.generation ||
			state.token !== request.token ||
			state.token !== saved.token ||
			state.columns !== saved.value.columns ||
			state.rows !== saved.value.rows ||
			!saved.value.valid()
		)
			return true;
		const { x, y, scroll, columns, rows } = request;
		if (
			!Number.isSafeInteger(x) ||
			!Number.isSafeInteger(y) ||
			!Number.isSafeInteger(scroll) ||
			x! < 0 ||
			x! >= state.columns ||
			y! < 0 ||
			y! >= state.rows ||
			scroll! < 0 ||
			columns !== state.columns ||
			rows !== state.rows ||
			state.scroll !== scroll
		)
			return true;
		const index = saved.value.screenTop + y! - scroll!;
		const owner = saved.value.owners[index];
		if (!owner) return true;
		let first = index;
		while (first > 0 && saved.value.owners[first - 1] === owner) first--;
		return this.#refresh(state, owner, index - first, y!);
	}

	async #enter(state: PaneState): Promise<boolean> {
		const snapshot = await this.host.capture();
		if (!snapshot) return false;
		try {
			if (this.#stopped || !snapshot.valid() || snapshot.columns !== state.columns || snapshot.rows !== state.rows)
				return false;
			const token = `${process.pid}-${++this.#sequence}`;
			await this.#tmux(
				"if",
				"-F",
				"-t",
				this.pane,
				this.#guard(state),
				`set -p -t ${this.pane} @scrollback 1 ; copy-mode -e -t ${this.pane} ; ` +
					`set -p -t ${this.pane} @omp-history-snapshot ${token} ; send -t ${this.pane} -X -N 3 scroll-up`,
			);
			const entered = await this.#state();
			if (entered.mode && entered.token === token && entered.generation === state.generation + 1) {
				this.#snapshot = { value: snapshot, token, generation: entered.generation };
			}
			return true;
		} finally {
			snapshot.release();
		}
	}

	async #refresh(state: PaneState, owner: object, ownerRow: number, mouseY: number): Promise<boolean> {
		const snapshot = await this.host.capture(owner);
		if (!snapshot) return true;
		try {
			if (this.#stopped || !snapshot.valid() || snapshot.columns !== state.columns || snapshot.rows !== state.rows)
				return true;
			const first = snapshot.owners.indexOf(owner);
			if (first < 0) return true;
			let end = first + 1;
			while (snapshot.owners[end] === owner) end++;
			const index = Math.min(first + ownerRow, end - 1);
			// Stay in native history even if expansion moves the anchor into the live screen.
			const desired = Math.max(1, snapshot.screenTop + mouseY - index);
			const token = `${process.pid}-${++this.#sequence}`;
			const current = await this.#state();
			if (
				current.token !== state.token ||
				current.generation !== state.generation ||
				current.scroll !== state.scroll
			)
				return true;
			// Replaying may shrink tmux history and clamp its offset. Evaluate the delta
			// inside tmux AFTER refresh, not against the old frozen grid's scroll bound.
			const adjust =
				`if -F -t ${this.pane} '#{>:#{scroll_position},${desired}}' ` +
				`'send -t ${this.pane} -X -N "#{e|-:#{scroll_position},${desired}}" scroll-down' ` +
				`{ if -F -t ${this.pane} '#{<:#{scroll_position},${desired}}' ` +
				`'send -t ${this.pane} -X -N "#{e|-:${desired},#{scroll_position}}" scroll-up' }`;
			await this.#tmux(
				"if",
				"-F",
				"-t",
				this.pane,
				`#{&&:${this.#guard(state)},#{==:#{scroll_position},${state.scroll}}}`,
				`send -t ${this.pane} -X refresh-from-pane ; ${adjust} ; set -p -t ${this.pane} @omp-history-snapshot ${token}`,
			);
			const refreshed = await this.#state();
			if (refreshed.mode && refreshed.token === token && refreshed.generation === state.generation) {
				this.#snapshot = { value: snapshot, token, generation: refreshed.generation };
			}
			return true;
		} finally {
			snapshot.release();
		}
	}
}
