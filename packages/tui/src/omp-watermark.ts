import { randomUUID } from "node:crypto";
import { $which } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { classifyTerminalMultiplexer } from "./terminal-multiplexer";
import { isInsideTmux } from "./tmux";

const REFRESH = "python3 ~/.config/tmux/omp-watermark.py refresh #{q:session_id}";

interface TmuxWatermarkTarget {
	readonly pane: string;
	readonly run: (args: string[]) => boolean;
}

/** Lifecycle receipt only: Kitty owns the background image, not the terminal grid. */
export class OmpWatermark {
	readonly #owner = `${process.pid}-${randomUUID()}`;
	readonly #startSignal: string;
	readonly #stopSignal: string;
	#active = false;
	#claimed = false;
	#heartbeat: NodeJS.Timeout | undefined;

	constructor(
		readonly emit: (bytes: string) => void,
		readonly tmux?: TmuxWatermarkTarget | "remote",
	) {
		const key = tmux === "remote" ? "omp_watermark_remote" : "omp_watermark_instance";
		this.#startSignal = `\x1b]1337;SetUserVar=${key}=${Buffer.from(this.#owner).toString("base64")}\x07`;
		const release = tmux === "remote" ? Buffer.from(`-${this.#owner}`).toString("base64") : "";
		this.#stopSignal = `\x1b]1337;SetUserVar=${key}=${release}\x07`;
	}

	start(): void {
		if (this.#active) return;
		this.#active = true;
		if (this.tmux === "remote") {
			// The outer tmux pipe observer attributes plain OSC to this SSH pane.
			// Renew even when hidden or idle so a crashed process has a bounded lease.
			this.emit(this.#startSignal);
			this.#heartbeat = setInterval(() => this.emit(this.#startSignal), 2000);
			this.#heartbeat.unref();
			return;
		}
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
		if (this.tmux === "remote") {
			clearInterval(this.#heartbeat);
			this.#heartbeat = undefined;
			this.emit(this.#stopSignal);
			return;
		}
		if (!this.tmux) {
			this.emit(this.#stopSignal);
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
	const multiplexer = classifyTerminalMultiplexer(env);
	if (!multiplexer) return new OmpWatermark(emit);
	if (multiplexer !== "tmux" || !isInsideTmux(env)) return undefined;
	const hasPane = /^%\d+$/.test(env.TMUX_PANE ?? "");
	// SSH preserves TERM but not the outer server's socket or pane identity.
	// Never query a coincidental tmux server on the remote host.
	if (!env.TMUX && !hasPane) return new OmpWatermark(emit, "remote");
	if (isBunTestRuntime() || !env.TMUX || !hasPane) return undefined;
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
