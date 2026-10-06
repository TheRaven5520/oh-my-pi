/**
 * Log in to a model provider from the terminal.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { loginHelp as commandHelp } from "../cli/command-help";
import { runLoginCommand } from "../cli/login-cli";

export default class Login extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "Provider id (e.g. anthropic, openai-codex, sprilicred); omit to pick interactively",
			required: false,
		}),
		key: Args.string({
			description: "Sprilicred API key (optional; prompts when omitted)",
			required: false,
		}),
	};

	static examples = [
		`# Pick a provider interactively\n  ${APP_NAME} login`,
		`# Log in to a specific provider\n  ${APP_NAME} login anthropic`,
		`# Log in to Sprilicred\n  ${APP_NAME} login sprilicred`,
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Login);
		await runLoginCommand(args.provider, args.key);
	}
}
