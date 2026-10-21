import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";

export interface TmuxHistorySnapshot {
	owners: readonly (object | undefined)[];
	anchors: readonly (object | undefined)[];
	historyOffset: number;
	epoch: number;
	screenTop: number;
	columns: number;
	rows: number;
	release(): void;
	valid(): boolean;
}

export interface TmuxHistoryHost {
	/** Advertise application-owned wheel scrolling for this bridge lifetime. */
	viewportScroll?: boolean;
	capture(owner?: object, signal?: AbortSignal): Promise<TmuxHistorySnapshot | undefined>;
	setHistoryLimit(limit: number): void;
}

interface HistoryRequest {
	op: "wheel" | "click" | "drag-prepare" | "drag-commit" | "viewport-owner";
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
	historySize: number;
	frozenHistorySize?: number;
	press: string;
	modeName: string;
}

const execute = promisify(execFile);
const STATE_FORMAT =
	"#{pane_in_mode}\t#{@scrollback}\t#{@omp-history-generation}\t#{@omp-history-snapshot}\t#{pane_width}\t#{pane_height}\t#{scroll_position}\t#{history_limit}\t#{@omp-history-socket}\t#{history_size}\t#{@omp-history-press}\t#{@omp-history-size}\t#{pane_mode}\t#{@omp-history-dragging}";

/** Native tmux history owns scrolling/selection; only immutable row identities cross this socket. */
export class TmuxHistoryBridge {
	#server: Server;
	#clients = new Map<Socket, AbortController>();
	#stopped = false;
	#queue: Promise<void> = Promise.resolve();
	#pending = 0;
	#snapshot?: { value: TmuxHistorySnapshot; token: string; generation: number };
	#sequence = 0;
	#outputTimer?: NodeJS.Timeout;
	#outputDirty = false;
	#outputQueued = false;
	#capturing = false;
	#lifetime = new AbortController();
	#drag?: {
		value: TmuxHistorySnapshot;
		token: string;
		generation: number;
		timer: NodeJS.Timeout;
		controller: AbortController;
	};

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
			if (host.viewportScroll) {
				// One blocking helper owns the pane option while this socket lives.
				// EOF also revokes it after SIGKILL, without polling or wheel jobs.
				const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
				await bridge.#tmux(
					undefined,
					"run-shell",
					"-b",
					`python3 #{?@omp-natural-scroll-helper,#{q:@omp-natural-scroll-helper},~/.config/tmux/natural-scroll.py} --viewport-owner ${quote(pane)} ${quote(bridge.socketPath)} ${quote(serverSocket)}`,
				);
			}
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
		this.#lifetime.abort();
		clearTimeout(this.#outputTimer);
		this.#releaseDrag();
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
					`set -pu -t ${this.pane} @omp-history-socket ; set -pu -t ${this.pane} @omp-history-snapshot ; if -F -t ${this.pane} '#{==:#{@omp-viewport-scroll},${this.socketPath}}' 'set -pu -t ${this.pane} @omp-viewport-scroll'`,
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
			historySize: Number(values[9]),
			frozenHistorySize: values[11] ? Number(values[11]) : undefined,
			// A held click or an in-progress drag both own the view until release.
			press: values[10] || values[13] || "",
			modeName: values[12] ?? "",
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
				request?.op === "viewport-owner" &&
				request.pane === this.pane &&
				this.host.viewportScroll &&
				!this.#stopped
			) {
				clearTimeout(deadline);
				socket.write('{"ok":true}\n');
				return;
			}
			if (
				!request ||
				request.pane !== this.pane ||
				!Number.isSafeInteger(request.generation) ||
				!["wheel", "click", "drag-prepare", "drag-commit"].includes(request.op) ||
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
		if (state.mode) clauses.push(`#{==:#{@omp-history-snapshot},${token}}`);
		return clauses.reduce((left, right) => `#{&&:${left},${right}}`);
	}

	/** Coalesce paints; no child process or polling remains after stop/mode exit. */
	notifyOutput(): void {
		if (this.#stopped || this.#capturing) return;
		this.#outputDirty = true;
		this.#scheduleOutput();
	}

	#scheduleOutput(): void {
		if (this.#stopped || this.#outputTimer || this.#outputQueued) return;
		this.#outputTimer = setTimeout(() => {
			this.#outputTimer = undefined;
			this.#outputQueued = true;
			this.#queue = this.#queue.then(async () => {
				try {
					if (this.#outputDirty && !this.#stopped) await this.#refreshOutput(this.#lifetime.signal);
				} catch {
					// Retain the frozen view on failure; only a successful refresh publishes identities.
				} finally {
					this.#outputQueued = false;
					if (this.#outputDirty) this.#scheduleOutput();
				}
			});
		}, 250);
		this.#outputTimer.unref();
	}

	async #capture(owner: object | undefined, signal: AbortSignal): Promise<TmuxHistorySnapshot | undefined> {
		this.#capturing = true;
		try {
			return await this.host.capture(owner, signal);
		} finally {
			this.#capturing = false;
		}
	}

	async #refreshOutput(signal: AbortSignal): Promise<void> {
		this.#outputDirty = false;
		const state = await this.#state(signal);
		if (!state.mode || state.modeName !== "copy-mode" || state.socket !== this.socketPath) return;
		const saved = this.#snapshot;
		const matched =
			saved &&
			state.token === saved.token &&
			state.generation === saved.generation &&
			state.columns === saved.value.columns &&
			state.rows === saved.value.rows;
		// An empty token is ordinary native copy mode, which also receives output.
		// A foreign token belongs to a different transaction and must not be adopted.
		if (!matched && state.token) return;
		if (state.press) {
			this.#outputDirty = true;
			return;
		}
		const snapshot = await this.#capture(undefined, signal);
		if (!snapshot) return;
		try {
			if (!snapshot.valid() || snapshot.columns !== state.columns || snapshot.rows !== state.rows) return;
			const current = await this.#state(signal);
			// Raw native coordinates also cover blank/ownerless rows and explicit
			// copy-mode entry. Growth below the view increases its offset, not its top.
			let desired = Math.max(0, state.scroll + current.historySize - (state.frozenHistorySize ?? state.historySize));
			if (matched) {
				let anchor = saved.value.screenTop - state.scroll;
				if (snapshot.epoch === saved.value.epoch) {
					anchor += saved.value.historyOffset - snapshot.historyOffset;
					desired = Math.max(0, snapshot.screenTop - anchor);
				} else {
					// Prefer a retained visible owner across a replay. If none survives,
					// refresh at the raw top row rather than freezing an obsolete view.
					for (let y = 0; y < state.rows; y++) {
						const owner = saved.value.anchors[anchor + y];
						if (!owner) continue;
						const next = snapshot.anchors.indexOf(owner);
						if (next < 0) continue;
						anchor += y;
						let first = anchor;
						while (first > 0 && saved.value.anchors[first - 1] === owner) first--;
						let end = next + 1;
						while (snapshot.anchors[end] === owner) end++;
						anchor = Math.min(next + anchor - first, end - 1);
						desired = Math.max(0, snapshot.screenTop + y - anchor);
						break;
					}
				}
			}
			const token = `${process.pid}-${++this.#sequence}`;
			const guard = [
				this.#guard(state),
				`#{==:#{scroll_position},${state.scroll}}`,
				"#{==:#{pane_mode},copy-mode}",
				"#{==:#{@omp-history-press},}",
				"#{==:#{@omp-history-dragging},}",
			].reduce((a, b) => `#{&&:${a},${b}}`);
			// The user wants incoming output to clear residual selections, exactly as
			// native refresh-from-pane does. Never cancel mode or force tail-follow.
			await this.#tmux(
				signal,
				"if",
				"-F",
				"-t",
				this.pane,
				guard,
				`send -t ${this.pane} -X history-bottom ; send -t ${this.pane} -X refresh-from-pane ; ` +
					(desired > 0 ? `send -t ${this.pane} -X -N ${desired} scroll-up ; ` : "") +
					`set -p -t ${this.pane} @omp-history-snapshot ${token} ; ` +
					`set -p -t ${this.pane} @omp-history-size ${current.historySize}`,
			);
			const after = await this.#state(signal);
			if (after.mode && after.token === token && after.generation === state.generation && snapshot.valid()) {
				this.#snapshot = { value: snapshot, token, generation: after.generation };
			} else if (after.mode && after.token === state.token && after.generation === state.generation) {
				this.#outputDirty = true;
			}
		} finally {
			snapshot.release();
		}
	}

	#releaseDrag(): void {
		const drag = this.#drag;
		if (!drag) return;
		this.#drag = undefined;
		clearTimeout(drag.timer);
		drag.value.release();
		drag.controller.abort();
	}

	async #prepareDrag(state: PaneState, request: HistoryRequest, signal: AbortSignal): Promise<boolean> {
		if (state.mode || state.generation !== request.generation) return true;
		this.#releaseDrag();
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		let snapshot: TmuxHistorySnapshot | undefined;
		let held = false;
		try {
			snapshot = await this.#capture(undefined, controller.signal);
			if (
				!snapshot ||
				!snapshot.valid() ||
				this.#stopped ||
				signal.aborted ||
				snapshot.columns !== state.columns ||
				snapshot.rows !== state.rows
			)
				return false;
			const token = `${process.pid}-${++this.#sequence}`;
			await this.#tmux(
				signal,
				"if",
				"-F",
				"-t",
				this.pane,
				this.#guard(state),
				`set -p -t ${this.pane} @omp-history-snapshot ${token}`,
			);
			const timer = setTimeout(() => {
				this.#releaseDrag();
				void this.#tmux(
					undefined,
					"if",
					"-F",
					"-t",
					this.pane,
					`#{&&:#{==:#{@omp-history-socket},${this.socketPath}},#{==:#{@omp-history-snapshot},${token}}}`,
					`set -pu -t ${this.pane} @omp-history-snapshot`,
				).catch(() => {});
			}, 3000);
			timer.unref();
			this.#drag = { value: snapshot, token, generation: state.generation + 1, timer, controller };
			held = true;
			return true;
		} finally {
			signal.removeEventListener("abort", abort);
			if (!held) {
				snapshot?.release();
				controller.abort();
			}
		}
	}

	#commitDrag(state: PaneState, request: HistoryRequest): boolean {
		const drag = this.#drag;
		if (!drag) return true;
		if (
			state.mode &&
			state.scrollback &&
			state.token === drag.token &&
			request.token === drag.token &&
			// A blocking helper in the original copy-mode command list runs before
			// its queued pane-mode-changed hook. Adopt the exact prepared token now,
			// but retain the post-hook generation used by subsequent mouse events.
			(state.generation === drag.generation || state.generation + 1 === drag.generation) &&
			(request.generation === state.generation || request.generation + 1 === state.generation) &&
			state.columns === drag.value.columns &&
			state.rows === drag.value.rows &&
			drag.value.valid()
		) {
			this.#snapshot = { value: drag.value, token: drag.token, generation: drag.generation };
		}
		this.#releaseDrag();
		return true;
	}

	async #handle(request: HistoryRequest, signal: AbortSignal): Promise<boolean> {
		const state = await this.#state(signal);
		if (state.socket !== this.socketPath || this.#stopped || signal.aborted) return false;
		if (request.op === "drag-prepare") return this.#prepareDrag(state, request, signal);
		if (request.op === "drag-commit") return this.#commitDrag(state, request);
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
		const snapshot = await this.#capture(undefined, signal);
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
					`set -p -t ${this.pane} @omp-history-snapshot ${token} ; ` +
					`set -pF -t ${this.pane} @omp-history-size '#{history_size}' ; send -t ${this.pane} -X -N 3 scroll-up`,
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
			snapshot = await this.#capture(owner, signal);
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
			// tmux 3.4 redraws immediately on refresh without clamping the old offset:
			// move to bottom FIRST or shrinking the backing can crash the server.
			// A positive literal count also avoids lexical format comparisons.
			await this.#tmux(
				signal,
				"if",
				"-F",
				"-t",
				this.pane,
				`#{&&:${this.#guard(state)},#{==:#{scroll_position},${state.scroll}}}`,
				`send -t ${this.pane} -X history-bottom ; send -t ${this.pane} -X refresh-from-pane ; ` +
					`send -t ${this.pane} -X -N ${desired} scroll-up ; set -p -t ${this.pane} @omp-history-snapshot ${token} ; ` +
					`set -p -t ${this.pane} @omp-history-size ${current.historySize}`,
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
