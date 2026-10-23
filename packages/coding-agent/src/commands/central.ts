/** Open the cross-chat question inbox. */
import { execReplace } from "@oh-my-pi/pi-natives";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { getProjectDir, postmortem } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { CentralSources } from "../central/sources";
import { serveCentralStdio } from "../central/sources";
import { CENTRAL_FOCUS_PREFIX, createCentralFocusCommands } from "../central/focus-commands";
import {
	cfgCentralFocusBoardUrl,
	cfgCentralFocusHqmsg,
	cfgCentralFocusPauseFile,
	cfgCentralHosts,
	cfgCentralIdentity,
} from "../central/settings";
import { centralHelp as commandHelp } from "../cli/command-help";
import { Settings, settings } from "../config/settings";
import { InstalledBuildWatcher, runningExecutablePath } from "../installed-build";
import { cfgColorBlindMode, cfgSymbolPreset, cfgThemeDark, cfgThemeLight } from "../modes/settings";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { type CentralExit, runCentralTui } from "@oh-my-pi/pi-tui/apps/central/central-tui";

export default class Central extends Command {
	static description = commandHelp.description;

	static flags = {
		bridge: Flags.boolean({ description: "Internal JSONL bridge for an SSH-hosted Central source" }),
		focus: Flags.string({
			description:
				"Focus one chat (Central name, sessionId or chatId): its replies, questions and a prefixed composer",
		}),
	};

	static examples = [
		"omp --central",
		"omp central",
		'omp central --focus "My chat"',
		"omp config set central.hosts '[\"user@mini\"]'",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Central);
		const build = new InstalledBuildWatcher(runningExecutablePath());
		if (flags.bridge) {
			await serveCentralStdio(() => build.ready());
			return;
		}
		const target = flags.focus?.trim();
		if (flags.focus !== undefined && !target) {
			process.stderr.write("omp central --focus needs a chat name, sessionId or chatId\n");
			process.exitCode = 2;
			return;
		}
		await Settings.init({ cwd: getProjectDir() });
		await initTheme(
			false,
			cfgSymbolPreset.get(settings),
			cfgColorBlindMode.get(settings),
			cfgThemeDark.get(settings),
			cfgThemeLight.get(settings),
		);
		const hosts = cfgCentralHosts.get(settings).filter(host => host.trim().length > 0);
		const identity = cfgCentralIdentity.get(settings).trim() || undefined;
		const sources = new CentralSources(hosts, identity);
		const focus = target
			? {
					target,
					prefix: CENTRAL_FOCUS_PREFIX,
					commands: createCentralFocusCommands({
						hqmsg: cfgCentralFocusHqmsg.get(settings),
						pauseFile: cfgCentralFocusPauseFile.get(settings),
						boardUrl: cfgCentralFocusBoardUrl.get(settings),
					}),
				}
			: undefined;
		let exit: CentralExit;
		try {
			exit = await runCentralTui(sources, { restartReady: () => build.ready() }, focus);
		} finally {
			sources.close();
		}
		if (exit === "restart") await restartIntoInstalledBuild();
	}
}

/** The same arguments, including `--focus <target>`, on the newly installed build. */
export function centralRestartCommand(argv: readonly string[] = process.argv): string[] {
	return [...resolveCliEntryCmd(), ...argv.slice(2)];
}

/** Replace this process with the newly installed build, same arguments, same terminal. */
async function restartIntoInstalledBuild(): Promise<void> {
	const cmd = centralRestartCommand();
	await postmortem.cleanup();
	await postmortem.drainStdout();
	try {
		execReplace(cmd); // never returns on success
	} catch (error) {
		process.stderr.write(`Central could not restart into the new OMP build: ${String(error)}\n`);
		process.exitCode = 1;
	}
}
