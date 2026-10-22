/** Open the cross-chat question inbox. */
import { execReplace } from "@oh-my-pi/pi-natives";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { getProjectDir, postmortem } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { CentralSources } from "../central/sources";
import { serveCentralStdio } from "../central/sources";
import { cfgCentralHosts, cfgCentralIdentity } from "../central/settings";
import { centralHelp as commandHelp } from "../cli/command-help";
import { Settings, settings } from "../config/settings";
import { InstalledBuildWatcher, runningExecutablePath } from "../installed-build";
import { cfgColorBlindMode, cfgSymbolPreset, cfgThemeDark, cfgThemeLight } from "../modes/settings";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { runCentralTui } from "@oh-my-pi/pi-tui/apps/central/central-tui";

export default class Central extends Command {
	static description = commandHelp.description;

	static flags = {
		bridge: Flags.boolean({ description: "Internal JSONL bridge for an SSH-hosted Central source" }),
	};

	static examples = ["omp --central", "omp central", "omp config set central.hosts '[\"user@mini\"]'"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Central);
		const build = new InstalledBuildWatcher(runningExecutablePath());
		if (flags.bridge) {
			await serveCentralStdio(() => build.ready());
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
		let exit: Awaited<ReturnType<typeof runCentralTui>>;
		try {
			exit = await runCentralTui(sources, { restartReady: () => build.ready() });
		} finally {
			sources.close();
		}
		if (exit === "restart") await restartIntoInstalledBuild();
	}
}

/** Replace this process with the newly installed build, same arguments, same terminal. */
async function restartIntoInstalledBuild(): Promise<void> {
	const cmd = [...resolveCliEntryCmd(), ...process.argv.slice(2)];
	await postmortem.cleanup();
	await postmortem.drainStdout();
	try {
		execReplace(cmd); // never returns on success
	} catch (error) {
		process.stderr.write(`Central could not restart into the new OMP build: ${String(error)}\n`);
		process.exitCode = 1;
	}
}
