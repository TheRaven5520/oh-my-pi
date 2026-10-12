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
	capture(owner?: object, signal?: AbortSignal): Promise<TmuxHistorySnapshot | undefined>;
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
	#clients = new Map<Socket, AbortController>();
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
			await bridge.#tmux(undefined, "set", "-p", "-t", pane, "@omp-history-socket", bridge.socketPath);
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
		for (const [client, controller] of this.#clients) {
			controller.abort();
			client.destroy();
		}
		this.#server.close();
		// Let an in-flight mutation cancel its own frozen mode before removing the
		// socket identity that protects that cancellation from newer owners.
		void this.#queue
			.then(() =>
				this.#tmux(
					undefined,
					"if",
					"-F",
					"-t",
					this.pane,
					`#{==:#{@omp-history-socket},${this.socketPath}}`,
					`set -pu -t ${this.pane} @omp-history-socket ; set -pu -t ${this.pane} @omp-history-snapshot`,
				),
			)
			.catch(() => {})
			.finally(() => rm(this.directory, { recursive: true, force: true }).catch(() => {}));
	}

	async #tmux(signal: AbortSignal | undefined, ...args: string[]): Promise<string> {
		signal?.throwIfAborted();
		const { stdout } = await execute("tmux", ["-S", this.serverSocket, ...args], {
			timeout: 2000,
			maxBuffer: 8192,
			signal,
		});
		return stdout.trim();
	}

	async #state(signal?: AbortSignal): Promise<PaneState> {
		const values = (await this.#tmux(signal, "display", "-p", "-t", this.pane, STATE_FORMAT)).split("\t");
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
		const controller = new AbortController();
		const { signal } = controller;
		this.#clients.set(socket, controller);
		socket.setEncoding("utf8");
		// Includes queue time and leaves headroom before the helper's five-second timeout.
		const deadline = setTimeout(() => {
			controller.abort();
			socket.destroy();
		}, 4000);
		deadline.unref();
		socket.on("error", () => controller.abort());
		socket.on("end", () => controller.abort());
		socket.on("close", () => {
			controller.abort();
			clearTimeout(deadline);
			this.#clients.delete(socket);
		});
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
					if (!this.#stopped && !signal.aborted) ok = await this.#handle(request, signal);
				} catch {
					/* A failed fence or dead pane never resolves a guessed owner. */
				} finally {
					this.#pending--;
					clearTimeout(deadline);
					if (!socket.destroyed && !socket.writableEnded) socket.end(`${JSON.stringify({ ok })}\n`);
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

	async #handle(request: HistoryRequest, signal: AbortSignal): Promise<boolean> {
		const state = await this.#state(signal);
		if (state.socket !== this.socketPath || this.#stopped || signal.aborted) return false;
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
				await this.#tmux(
					signal,
					"if",
					"-F",
					"-t",
					this.pane,
					this.#guard(state),
					`send -t ${this.pane} -X -N 3 scroll-up`,
				);
				return true;
			}
			if (state.generation !== request.generation) return true;
			return this.#enter(state, signal);
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
		return this.#refresh(state, owner, index - first, y!, signal);
	}

	async #enter(state: PaneState, signal: AbortSignal): Promise<boolean> {
		const snapshot = await this.host.capture(undefined, signal);
		if (!snapshot) return false;
		const token = `${process.pid}-${++this.#sequence}`;
		let committed = false;
		let attempted = false;
		try {
			if (
				this.#stopped ||
				signal.aborted ||
				!snapshot.valid() ||
				snapshot.columns !== state.columns ||
				snapshot.rows !== state.rows
			)
				return false;
			attempted = true;
			await this.#tmux(
				signal,
				"if",
				"-F",
				"-t",
				this.pane,
				this.#guard(state),
				`set -p -t ${this.pane} @scrollback 1 ; copy-mode -e -t ${this.pane} ; ` +
					`set -p -t ${this.pane} @omp-history-snapshot ${token} ; send -t ${this.pane} -X -N 3 scroll-up`,
			);
			const entered = await this.#state(signal);
			if (
				!signal.aborted &&
				snapshot.valid() &&
				entered.mode &&
				entered.token === token &&
				entered.generation === state.generation + 1
			) {
				this.#snapshot = { value: snapshot, token, generation: entered.generation };
				committed = true;
			}
			return true;
		} finally {
			snapshot.release();
			if (attempted && !committed) await this.#discard({ ...state, generation: state.generation + 1, token });
		}
	}

	/** Cancel only our original native mode, never a mode the user entered meanwhile. */
	async #discard(state: PaneState, replacementToken?: string): Promise<void> {
		const saved = this.#snapshot;
		if (saved?.generation === state.generation && (saved.token === state.token || saved.token === replacementToken))
			this.#snapshot = undefined;
		const original = `#{==:#{@omp-history-snapshot},${state.token}}`;
		const token = replacementToken
			? `#{||:${original},#{==:#{@omp-history-snapshot},${replacementToken}}}`
			: original;
		const guard = [
			`#{==:#{@omp-history-socket},${this.socketPath}}`,
			`#{==:#{@omp-history-generation},${state.generation}}`,
			"#{==:#{pane_in_mode},1}",
			"#{==:#{@scrollback},1}",
			token,
		].reduce((left, right) => `#{&&:${left},${right}}`);
		await this.#tmux(
			undefined,
			"if",
			"-F",
			"-t",
			this.pane,
			guard,
			`set -pu -t ${this.pane} @omp-history-snapshot ; send -t ${this.pane} -X cancel`,
		).catch(() => {});
	}

	async #refresh(
		state: PaneState,
		owner: object,
		ownerRow: number,
		mouseY: number,
		signal: AbortSignal,
	): Promise<boolean> {
		// The previous request may have waited in the queue while native selection moved.
		const before = await this.#state(signal);
		if (
			this.#stopped ||
			signal.aborted ||
			!before.mode ||
			!before.scrollback ||
			before.socket !== this.socketPath ||
			before.token !== state.token ||
			before.generation !== state.generation ||
			before.scroll !== state.scroll ||
			before.columns !== state.columns ||
			before.rows !== state.rows
		)
			return true;
		let snapshot: TmuxHistorySnapshot | undefined;
		let committed = false;
		let token: string | undefined;
		try {
			// capture(owner) can mutate before returning or throwing: every failure below
			// must reveal the live grid instead of retaining the old frozen copy.
			snapshot = await this.host.capture(owner, signal);
			if (
				!snapshot ||
				this.#stopped ||
				signal.aborted ||
				!snapshot.valid() ||
				snapshot.columns !== state.columns ||
				snapshot.rows !== state.rows
			)
				return true;
			const first = snapshot.owners.indexOf(owner);
			if (first < 0) return true;
			let end = first + 1;
			while (snapshot.owners[end] === owner) end++;
			const index = Math.min(first + ownerRow, end - 1);
			// Stay in native history even if expansion moves the anchor into the live screen.
			const desired = Math.max(1, snapshot.screenTop + mouseY - index);
			token = `${process.pid}-${++this.#sequence}`;
			const current = await this.#state(signal);
			if (
				signal.aborted ||
				!snapshot.valid() ||
				!current.mode ||
				!current.scrollback ||
				current.socket !== this.socketPath ||
				current.token !== state.token ||
				current.generation !== state.generation ||
				current.scroll !== state.scroll ||
				current.columns !== state.columns ||
				current.rows !== state.rows
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
				signal,
				"if",
				"-F",
				"-t",
				this.pane,
				`#{&&:${this.#guard(state)},#{==:#{scroll_position},${state.scroll}}}`,
				`send -t ${this.pane} -X refresh-from-pane ; ${adjust} ; set -p -t ${this.pane} @omp-history-snapshot ${token}`,
			);
			const refreshed = await this.#state(signal);
			if (
				!signal.aborted &&
				snapshot.valid() &&
				refreshed.mode &&
				refreshed.token === token &&
				refreshed.generation === state.generation
			) {
				this.#snapshot = { value: snapshot, token, generation: refreshed.generation };
				committed = true;
			}
			return true;
		} finally {
			snapshot?.release();
			if (!committed) await this.#discard(state, token);
		}
	}
}
