/**
 * Check for and install updates.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Update extends Command {
	static description = commandHelp.description;

	static flags = {
		check: Flags.boolean({
			char: "c",
			description: "Report the omp release Sprilicred publishes without installing",
			default: false,
		}),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
	};

	static examples = [
		"# Run the Sprilicred installer for omp (curl $SPRILICRED_URL/install.sh | sh -s -- --clients omp --yes)\n  omp update",
		"omp update --check",
		"omp update --plugins",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			await updateCli.runUpdateCommand({ check: flags.check });
		}
	}
}
