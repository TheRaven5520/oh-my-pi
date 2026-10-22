import { randomUUID } from "node:crypto";
import { $which } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { classifyTerminalMultiplexer } from "./terminal-multiplexer";
import { isInsideTmux } from "./tmux";

export interface ReplyAlert {
	set(): void;
	ack(): void;
}

/**
 * Signals whether this pane has an open interactive question. Never throws.
 * Commands complete in order, including the final acknowledgment during exit.
 * Returns undefined when no tmux owns this terminal.
 */
export function resolveReplyAlert(
	emit: (bytes: string) => void,
	env: NodeJS.ProcessEnv = Bun.env,
	run?: (args: string[]) => void,
): ReplyAlert | undefined {
	if (classifyTerminalMultiplexer(env) !== "tmux" || !isInsideTmux(env)) return undefined;
	const pane = env.TMUX_PANE ?? "";
	const hasPane = /^%\d+$/.test(pane);
	// Over SSH the outer tmux pipe observer attributes this frame to its pane.
	// Never query a coincidental tmux server on the remote host.
	if (!env.TMUX && !hasPane) {
		const nonce = Buffer.from(`${process.pid}-${randomUUID()}`).toString("base64");
		let heartbeat: NodeJS.Timeout | undefined;
		const send = (key: string): void => {
			try {
				emit(`\x1b]1337;SetUserVar=${key}=${nonce}\x07`);
			} catch {
				/* The terminal may already be closed. */
			}
		};
		return {
			set: () => {
				send("omp_reply_alert");
				// Separate from terminal/watermark ownership: questions survive an
				// external editor or suspension of their on-screen presentation.
				heartbeat ??= setInterval(() => send("omp_reply_alert"), 2_000);
				heartbeat.unref();
			},
			ack: () => {
				clearInterval(heartbeat);
				heartbeat = undefined;
				send("omp_reply_ack");
			},
		};
	}
	if (!env.TMUX || !hasPane) return undefined;
	if (!run) {
		if (isBunTestRuntime()) return undefined;
		const tmux = $which("tmux", { PATH: env.PATH });
		if (!tmux) return undefined;
		run = args => {
			Bun.spawnSync([tmux, ...args], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		};
	}
	const execute = run;
	const send = (action: "set" | "ack"): void => {
		try {
			// No -b: a late set must never overtake the last question's ack.
			execute([
				"run-shell",
				"-t",
				pane,
				`python3 ~/.config/tmux/reply-alert.py ${action} #{pane_id}${action === "set" ? ` ${process.pid}` : ""}`,
			]);
		} catch {
			/* Best effort when the helper or tmux server is unavailable. */
		}
	};
	return { set: () => send("set"), ack: () => send("ack") };
}
