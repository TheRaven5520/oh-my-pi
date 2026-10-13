import { randomUUID } from "node:crypto";
import { $which } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { isInsideTmux } from "./tmux";

const REFRESH = "python3 ~/.config/tmux/status-padding.py refresh #{q:session_id}";

/** A single process's receipt for the last completed status-line paint. */
export class TmuxStatusPadding {
	readonly #owner = `${process.pid}-${randomUUID()}`;
	readonly #ownerGuard = `#{==:#{@omp-status-padding-owner},${this.#owner}}`;
	#last: string | undefined;
	#claimed = false;
	#stopped = false;

	constructor(
		readonly tmuxPath: string,
		readonly pane: string,
		readonly env: NodeJS.ProcessEnv,
		readonly run: (args: string[]) => boolean = args => {
			try {
				return (
					Bun.spawnSync([tmuxPath, ...args], {
						env,
						stdin: "ignore",
						stdout: "ignore",
						stderr: "ignore",
						timeout: 500,
						killSignal: "SIGKILL",
					}).exitCode === 0
				);
			} catch {
				return false;
			}
		},
	) {}

	publish(atBottom: boolean, background: string | undefined): void {
		if (this.#stopped || !/^%\d+$/.test(this.pane)) return;
		const color = background && /^#[0-9a-f]{6}$/i.test(background) ? background.toLowerCase() : "";
		const active = atBottom && color !== "" ? "1" : "0";
		const state = `${active}:${color}`;
		if (state === this.#last) return;
		// A failed command is retried only on a state transition, never once per frame.
		this.#last = state;
		const update =
			`set-option -p -t ${this.pane} @omp-status-padding-owner ${this.#owner} ; ` +
			`set-option -p -t ${this.pane} @omp-status-padding-bg '${color}' ; ` +
			`set-option -p -t ${this.pane} @omp-status-at-bottom ${active} ; ` +
			`run-shell -b -t ${this.pane} '${REFRESH}'`;
		if (!this.#claimed) {
			this.#claimed = this.run(["if-shell", "-F", "-t", this.pane, "1", update]);
		} else {
			this.run(["if-shell", "-F", "-t", this.pane, this.#ownerGuard, update]);
		}
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		if (!this.#claimed) return;
		this.run([
			"if-shell",
			"-F",
			"-t",
			this.pane,
			this.#ownerGuard,
			`set-option -pu -t ${this.pane} @omp-status-at-bottom ; ` +
				`set-option -pu -t ${this.pane} @omp-status-padding-bg ; ` +
				`set-option -pu -t ${this.pane} @omp-status-padding-owner ; ` +
				`run-shell -b -t ${this.pane} '${REFRESH}'`,
		]);
	}
}

export function resolveTmuxStatusPadding(env: NodeJS.ProcessEnv = Bun.env): TmuxStatusPadding | undefined {
	if (isBunTestRuntime() || !isInsideTmux(env) || !/^%\d+$/.test(env.TMUX_PANE ?? "")) return undefined;
	const tmux = $which("tmux", { PATH: env.PATH });
	return tmux ? new TmuxStatusPadding(tmux, env.TMUX_PANE!, env) : undefined;
}
