/** Open the cross-chat question inbox. */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { CentralSources } from "../central/sources";
import { serveCentralStdio } from "../central/sources";
import { cfgCentralHosts, cfgCentralIdentity } from "../central/settings";
import { centralHelp as commandHelp } from "../cli/command-help";
import { Settings, settings } from "../config/settings";
import { cfgColorBlindMode, cfgSymbolPreset, cfgThemeDark, cfgThemeLight } from "../modes/settings";
import { runCentralTui } from "@oh-my-pi/pi-tui/apps/central/central-tui";

export default class Central extends Command {
	static description = commandHelp.description;

	static flags = {
		bridge: Flags.boolean({ description: "Internal JSONL bridge for an SSH-hosted Central source" }),
	};

	static examples = ["omp --central", "omp central", "omp config set central.hosts '[\"user@mini\"]'"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Central);
		if (flags.bridge) {
			await serveCentralStdio();
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
		try {
			await runCentralTui(sources);
		} finally {
			sources.close();
		}
	}
}
