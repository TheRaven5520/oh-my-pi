import * as readline from "node:readline";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { accountHelp } from "../cli/command-help";
import { promptLine } from "../cli/oauth-terminal";
import { accountDbPath, listAccounts, withAccountStore } from "../config/personal-accounts";

export default class Account extends Command {
	static description = accountHelp.description;
	static args = {
		action: Args.string({ required: true, options: ["add", "list", "remove"], description: "Account action" }),
		target: Args.string({ description: "claude or chatgpt to add; label or provider id to remove" }),
	};
	static flags = { name: Flags.string({ description: "Display name (defaults to account email)" }) };

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Account);
		const dbPath = accountDbPath();
		if (args.action !== "add") {
			if (flags.name || (args.action === "list" ? args.target : !args.target))
				throw new Error(`Usage: omp account ${args.action}${args.action === "list" ? "" : " <name>"}`);
			await withAccountStore(dbPath, async storage => {
				const accounts = listAccounts(storage);
				if (args.action === "list") {
					for (const account of accounts) console.log(`${account.provider}\t${account.label}`);
					if (!accounts.length) console.log("No personal accounts.");
					return;
				}
				const matches = accounts.filter(
					account => account.label === args.target || account.provider === args.target,
				);
				if (matches.length !== 1)
					throw new Error(
						matches.length
							? "Ambiguous label; use the provider id from omp account list."
							: "Personal account not found.",
					);
				await storage.credentials.remove(matches[0].provider);
				console.log(`Removed ${matches[0].provider}.`);
			});
			return;
		}
		const kind = args.target;
		if (kind !== "claude" && kind !== "chatgpt")
			throw new Error("Usage: omp account add claude|chatgpt [--name <label>]");
		const login = getProviderDefinition(kind === "claude" ? "anthropic" : "openai-codex")?.login;
		if (!login) throw new Error(`No OAuth flow for ${kind}.`);
		// No readline output: never echo the pasted authorization code into the SSH transcript.
		const rl = readline.createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY) });
		const abort = new AbortController();
		const cancel = () => abort.abort(new Error("Login cancelled"));
		rl.once("SIGINT", cancel);
		rl.once("close", cancel);
		process.once("SIGINT", cancel);
		let credential: OAuthCredentials | string;
		try {
			credential = await login({
				signal: abort.signal,
				onAuth: ({ url }) => console.log(`Open this URL in your browser to sign in:\n${url}`),
				onPrompt: prompt => {
					console.log(prompt.message);
					return promptLine(rl, "", abort.signal);
				},
				onManualCodeInput: signal => {
					console.log("Paste the final redirect URL or authorization code:");
					return promptLine(rl, "", signal);
				},
			});
		} catch (error) {
			if (abort.signal.aborted || (error instanceof Error && error.message.includes("cancelled"))) {
				console.error("Login cancelled. No account was added.");
				process.exitCode = 130;
				return;
			} else {
				// Provider exchange errors can contain the raw response body.
				throw new Error(
					"Personal account sign-in failed. Check the provider sign-in and redirect, then try again.",
				);
			}
		} finally {
			process.off("SIGINT", cancel);
			rl.close();
		}
		if (typeof credential === "string") throw new Error("Expected a subscription login.");
		const label = (flags.name ?? credential.email ?? (kind === "claude" ? "Claude" : "ChatGPT")).trim();
		const slug = label
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");
		if (!slug || /[\p{Cc}\p{Cf}]/u.test(label))
			throw new Error("Use --name with a printable label containing a letter or digit.");
		const provider = `account-${kind}-${slug}`;
		await withAccountStore(dbPath, async storage => {
			if (listAccounts(storage).some(account => account.provider === provider))
				throw new Error(`Account ${provider} already exists; remove it first or use another name.`);
			await storage.credentials.set(provider, {
				type: "oauth",
				...credential,
				authorizedAt: Date.now(),
				accountLabel: label,
			});
		});
		console.log(`Added ${provider}. Pick a model in /model.`);
	}
}
