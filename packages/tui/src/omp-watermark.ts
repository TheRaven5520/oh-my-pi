import { randomUUID } from "node:crypto";
import { $which } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { isInsideTerminalMultiplexer } from "./terminal-multiplexer";
import { isInsideTmux } from "./tmux";

const REFRESH = "python3 ~/.config/tmux/omp-watermark.py refresh #{q:session_id}";

interface TmuxWatermarkTarget {
	readonly pane: string;
	readonly run: (args: string[]) => boolean;
}

/** Lifecycle receipt only: Kitty owns the background image, not the terminal grid. */
export class OmpWatermark {
	readonly #owner = `${process.pid}-${randomUUID()}`;
	readonly #startSignal = `\x1b]1337;SetUserVar=omp_watermark_instance=${Buffer.from(this.#owner).toString("base64")}\x07`;
	#active = false;
	#claimed = false;

	constructor(
		readonly emit: (bytes: string) => void,
		readonly tmux?: TmuxWatermarkTarget,
	) {}

	start(): void {
		if (this.#active) return;
		this.#active = true;
		if (!this.tmux) {
			this.emit(this.#startSignal);
			return;
		}
		const { pane, run } = this.tmux;
		if (!/^%\d+$/.test(pane)) return;
		this.#claimed = run([
			"set-option",
			"-p",
			"-t",
			pane,
			"@omp-watermark-owner",
			this.#owner,
			";",
			"run-shell",
			"-b",
			"-t",
			pane,
			REFRESH,
		]);
	}

	stop(): void {
		if (!this.#active) return;
		this.#active = false;
		if (!this.tmux) {
			this.emit("\x1b]1337;SetUserVar=omp_watermark_instance=\x07");
			return;
		}
		if (!this.#claimed) return;
		this.#claimed = false;
		const { pane, run } = this.tmux;
		run([
			"if-shell",
			"-F",
			"-t",
			pane,
			`#{==:#{@omp-watermark-owner},${this.#owner}}`,
			`set-option -pu -t ${pane} @omp-watermark-owner ; run-shell -b -t ${pane} '${REFRESH}'`,
		]);
	}
}

export function resolveOmpWatermark(
	emit: (bytes: string) => void,
	env: NodeJS.ProcessEnv = Bun.env,
): OmpWatermark | undefined {
	if (!isInsideTerminalMultiplexer(env)) return new OmpWatermark(emit);
	if (isBunTestRuntime() || !isInsideTmux(env) || !/^%\d+$/.test(env.TMUX_PANE ?? "")) return undefined;
	const tmux = $which("tmux", { PATH: env.PATH });
	if (!tmux) return undefined;
	return new OmpWatermark(emit, {
		pane: env.TMUX_PANE!,
		run: args => {
			try {
				return (
					Bun.spawnSync([tmux, ...args], {
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
	});
}
