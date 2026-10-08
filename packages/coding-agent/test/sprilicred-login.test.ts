import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as readline from "node:readline";
import { withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { clearConfigValueCache, resolveConfigValue } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSprilicredLogin } from "@oh-my-pi/pi-coding-agent/cli/sprilicred-login";
import { writeTokenFile } from "@oh-my-pi/pi-coding-agent/cli/token-file";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

// Every test supplies the key, so the login never prompts on this interface.
const noPrompt = {} as unknown as readline.Interface;

describe("Sprilicred login", () => {
	let root: string;
	let agentDir: string;
	let tokenPath: string;
	let price: number;
	let originalFetch: typeof fetch;
	let previousUrl: string | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-test-sprilicred-login-"));
		agentDir = path.join(root, ".omp", "agent");
		tokenPath = path.join(root, ".omp", "auth-broker.token");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({ providers: { other: { models: [{ id: "keep" }] } } }),
		);
		price = 1000;
		previousUrl = process.env.SPRILICRED_URL;
		process.env.SPRILICRED_URL = "https://sprilicred.test";
		originalFetch = globalThis.fetch;
		globalThis.fetch = (async input => {
			const anthropic = String(input).includes("/anthropic/");
			return Response.json({
				data: anthropic
					? [
							{
								id: "claude-haiku-4-5",
								context_window: 200000,
								max_output_tokens: 64000,
								supports_reasoning: true,
								input_modalities: ["text", "image"],
								pricing: {
									unit: "microcredits_per_token",
									input: price,
									output: 5000,
									cache_read: 100,
									cache_write: 200,
									fast_mode: { service_tiers: ["fast"] },
								},
							},
							{
								id: "claude-sonnet-5",
								context_window: 1000000,
								max_output_tokens: 128000,
								supports_reasoning: true,
								input_modalities: ["text"],
								pricing: {
									unit: "microcredits_per_token",
									input: price,
									output: 10000,
									cache_read: 200,
									cache_write: 2500,
									fast_mode: null,
								},
							},
						]
					: [
							{
								id: "gpt-6-astra",
								context_window: 272000,
								max_output_tokens: 128000,
								supports_reasoning: true,
								input_modalities: ["text", "image"],
								pricing: {
									unit: "microcredits_per_token",
									input: price,
									output: 50000,
									cache_read: 1000,
									cache_write: 0,
								},
							},
						],
			});
		}) as typeof fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		if (previousUrl === undefined) delete process.env.SPRILICRED_URL;
		else process.env.SPRILICRED_URL = previousUrl;
		await fs.rm(root, { recursive: true, force: true });
	});

	test("writes server metadata, preserves ownership, and refreshes owned prices", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		const paths = { home: root, agentDir, tokenPath };
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);

		const first = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		const anthropic = first.providers["sprilicred-anthropic"];
		expect(anthropic.models[0].cost.input).toBe(1);
		expect(anthropic.models[0].compat).toEqual({ supportsFastMode: true });
		expect(anthropic.models[1].compat).toBeUndefined();
		expect(anthropic.discovery).toEqual({ type: "openai-models-list" });
		expect(first.providers["sprilicred-openai"].discovery).toEqual({ type: "openai-models-list", injectV1: false });
		expect(first.providers.other.models[0].id).toBe("keep");
		expect(
			JSON.parse(await fs.readFile(path.join(root, ".sprilicred/omp-roles.json"), "utf8")).roles.default,
		).toBeString();

		const userEdit = first;
		userEdit.providers["sprilicred-anthropic"].models[0].contextWindow = 500000;
		await fs.writeFile(path.join(agentDir, "models.yml"), JSON.stringify(userEdit));
		cfgModelRoles.setEntry(settings, "smol", "other/keep");
		await settings.flush();

		price = 2000;
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const second = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(second.providers["sprilicred-anthropic"].models[0].cost.input).toBe(2);
		expect(second.providers["sprilicred-anthropic"].models[0].contextWindow).toBe(500000);
		expect(cfgModelRoles.get(settings).smol).toBe("other/keep");
		expect((await fs.readFile(tokenPath, "utf8")).trim()).toBe("test-key");
	});

	test("keeps the key only in ~/.sprilicred/user.key and links the broker token to it", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await fs.writeFile(tokenPath, "older-broker-token", { mode: 0o600 });
		await runSprilicredLogin(noPrompt, settings, "sk-spr-first", { home: root, agentDir, tokenPath });

		const keyPath = path.join(root, ".sprilicred", "user.key");
		expect(await fs.readFile(keyPath, "utf8")).toBe("sk-spr-first\n");
		expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
		expect((await fs.stat(path.dirname(keyPath))).mode & 0o777).toBe(0o700);
		expect((await fs.lstat(tokenPath)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(tokenPath)).toBe(keyPath);
		expect(await fs.readFile(`${tokenPath}.before-sprilicred`, "utf8")).toBe("older-broker-token");

		const models = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		const apiKey = `!cat '${keyPath}'`;
		expect(models.providers["sprilicred-anthropic"].apiKey).toBe(apiKey);
		expect(models.providers["sprilicred-openai"].apiKey).toBe(apiKey);
		expect(await fs.readFile(path.join(agentDir, "models.yml"), "utf8")).not.toContain("sk-spr-first");
		clearConfigValueCache();
		expect(await resolveConfigValue(apiKey)).toBe("sk-spr-first");

		// Rotating the key rewrites only the key file; both omp readers see it.
		await fs.writeFile(keyPath, "sk-spr-rotated\n");
		expect((await fs.readFile(tokenPath, "utf8")).trim()).toBe("sk-spr-rotated");
		clearConfigValueCache();
		expect(await resolveConfigValue(apiKey)).toBe("sk-spr-rotated");

		// A second login keeps the link and rewrites the key file in place.
		await runSprilicredLogin(noPrompt, settings, "sk-spr-second", { home: root, agentDir, tokenPath });
		expect(await fs.readlink(tokenPath)).toBe(keyPath);
		expect(await fs.readFile(keyPath, "utf8")).toBe("sk-spr-second\n");
		expect(await fs.readFile(`${tokenPath}.before-sprilicred`, "utf8")).toBe("older-broker-token");
	});

	test("rejects a key containing whitespace before writing anything", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await expect(
			runSprilicredLogin(noPrompt, settings, "sk-spr-a b", { home: root, agentDir, tokenPath }),
		).rejects.toThrow("whitespace");
		expect(await fs.exists(path.join(root, ".sprilicred", "user.key"))).toBe(false);
	});

	test("a locally generated broker token replaces the link instead of overwriting the key", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "sk-spr-kept", { home: root, agentDir, tokenPath });
		await writeTokenFile(tokenPath, "local-broker-token");
		expect((await fs.lstat(tokenPath)).isSymbolicLink()).toBe(false);
		expect(await fs.readFile(tokenPath, "utf8")).toBe("local-broker-token");
		expect(await fs.readFile(path.join(root, ".sprilicred", "user.key"), "utf8")).toBe("sk-spr-kept\n");
	});

	test("a key rotated mid-session is used on the first 401, without a retry loop", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		// The shared fixture's bare `other` provider is not loadable by ModelRegistry; start from an empty file.
		await fs.writeFile(path.join(agentDir, "models.yml"), "{}\n");
		await runSprilicredLogin(noPrompt, settings, "sk-spr-old", { home: root, agentDir, tokenPath });
		const keyPath = path.join(root, ".sprilicred", "user.key");
		const unauthorized = () => Object.assign(new Error("401 authentication_error"), { status: 401 });
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
			for (const [provider, id] of [
				["sprilicred-anthropic", "claude-sonnet-5"],
				["sprilicred-openai", "gpt-6-astra"],
			]) {
				const model = registry.find(provider, id);
				if (!model) throw new Error(`Expected ${provider}/${id} from the login's models.yml`);
				await fs.writeFile(keyPath, "sk-spr-old\n");
				clearConfigValueCache();
				expect(await registry.getApiKey(model)).toBe("sk-spr-old");

				// `sprilicred-connect key` rewrites the file while the session runs; the cached key stays until a 401.
				await fs.writeFile(keyPath, "sk-spr-new\n");
				expect(await registry.getApiKey(model)).toBe("sk-spr-old");
				const sent: string[] = [];
				const result = await withAuth(registry.resolver(model), async key => {
					sent.push(key);
					if (key !== "sk-spr-new") throw unauthorized();
					return "ok";
				});
				expect(result).toBe("ok");
				expect(sent).toEqual(["sk-spr-old", "sk-spr-new"]);
				expect((await registry.resolveModelHeaders(model))?.Authorization).toBe("Bearer sk-spr-new");
			}

			// A key Sprilicred keeps rejecting is re-read once and then the 401 surfaces.
			const model = registry.find("sprilicred-openai", "gpt-6-astra");
			if (!model) throw new Error("Expected sprilicred-openai/gpt-6-astra");
			const sent: string[] = [];
			await expect(
				withAuth(registry.resolver(model), async key => {
					sent.push(key);
					throw unauthorized();
				}),
			).rejects.toThrow("401");
			expect(sent).toEqual(["sk-spr-new"]);
		} finally {
			authStorage.close();
		}
	});
});
