import { randomUUID } from "node:crypto";
import { $which } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import { classifyTerminalMultiplexer } from "./terminal-multiplexer";
import { isInsideTmux } from "./tmux";

/** tmux expands `#{window_id}` against the target pane before running the helper. */
const ACK = "python3 ~/.config/tmux/reply-alert.py ack #{window_id}";
const REMOTE_KEY = "omp_reply_ack";

/**
 * Clears the tmux reply alert (the red tab rung by this chat's bell) after the
 * user replied from somewhere other than this terminal, e.g. OMP Central.
 * Returns undefined when no tmux owns this terminal. Never throws.
 */
export function resolveReplyAlertAck(
	emit: (bytes: string) => void,
	env: NodeJS.ProcessEnv = Bun.env,
	run?: (args: string[]) => void,
): (() => void) | undefined {
	if (classifyTerminalMultiplexer(env) !== "tmux" || !isInsideTmux(env)) return undefined;
	const pane = env.TMUX_PANE ?? "";
	const hasPane = /^%\d+$/.test(pane);
	// Over SSH the outer tmux pipe observer attributes this frame to its pane.
	// Never query a coincidental tmux server on the remote host.
	if (!env.TMUX && !hasPane) {
		return () => {
			const nonce = Buffer.from(`${process.pid}-${randomUUID()}`).toString("base64");
			try {
				emit(`\x1b]1337;SetUserVar=${REMOTE_KEY}=${nonce}\x07`);
			} catch {
				/* A closed terminal has no tab left to clear. */
			}
		};
	}
	if (!env.TMUX || !hasPane) return undefined;
	if (!run) {
		if (isBunTestRuntime()) return undefined;
		const tmux = $which("tmux", { PATH: env.PATH });
		if (!tmux) return undefined;
		run = args => {
			try {
				Bun.spawn([tmux, ...args], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
			} catch {
				/* Best effort: the tab clears on its own once visited. */
			}
		};
	}
	const execute = run;
	const command = ["run-shell", "-b", "-t", pane, ACK];
	return () => execute(command);
}
