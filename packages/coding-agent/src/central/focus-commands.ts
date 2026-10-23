import * as fs from "node:fs/promises";
import type { CentralFocusCommands } from "@oh-my-pi/pi-tui/apps/central/types";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { expandTilde } from "../tools/path-utils";

/**
 * Starts every focus-composer message. The coordinator reads it as the user's
 * own words; it is a text convention any sender can type, not authentication.
 */
export const CENTRAL_FOCUS_PREFIX = "[FOCUS: Shreyan says] ";

const COMMAND_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface CentralFocusConfig {
	/** Coordinator mailbox executable (`hqmsg`). */
	hqmsg: string;
	/** File whose presence pauses coordinator inbox steering. */
	pauseFile: string;
	boardUrl: string;
}

function configured(value: string, setting: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`Not configured: set ${setting} (omp config set ${setting} <value>)`);
	return expandTilde(trimmed);
}

/** Runs the mailbox tool directly (argv, no shell); a non-zero exit is an error carrying its output. */
async function runMailbox(executable: string, args: string[]): Promise<string> {
	const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const output = `${stdout}${stderr}`.slice(0, OUTPUT_LIMIT_BYTES);
		if (code !== 0) throw new Error(`${executable} exited with ${code}: ${output.trim() || "no output"}`);
		return output;
	} finally {
		clearTimeout(timer);
	}
}

/** Local `/send`, `/inbox`, `/pause`, `/resume` and `/dag`; each reports "not configured" when its setting is empty. */
export function createCentralFocusCommands(config: CentralFocusConfig): CentralFocusCommands {
	return {
		// `--to=` and `--` keep a chat name or message starting with `-` from being read as an option.
		relay: async (chat, message) =>
			runMailbox(configured(config.hqmsg, "central.focus.hqmsg"), [
				"--from",
				"FOCUS",
				"--kind",
				"relay",
				`--to=${chat}`,
				"--",
				message,
			]),
		inbox: async count => runMailbox(configured(config.hqmsg, "central.focus.hqmsg"), ["--tail", String(count)]),
		async setPaused(paused) {
			const file = configured(config.pauseFile, "central.focus.pauseFile");
			if (paused) await fs.writeFile(file, "", { flag: "a" });
			else await fs.rm(file, { force: true });
			try {
				await fs.stat(file);
				return `Inbox steering paused (${file} exists)`;
			} catch (error) {
				if (!isEnoent(error)) throw error;
				return `Inbox steering running (${file} absent)`;
			}
		},
		boardUrl: () => configured(config.boardUrl, "central.focus.boardUrl"),
	};
}
