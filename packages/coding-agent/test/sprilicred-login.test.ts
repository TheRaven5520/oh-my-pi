import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSprilicredLogin } from "@oh-my-pi/pi-coding-agent/cli/sprilicred-login";

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
		await runSprilicredLogin({} as any, settings, "test-key", paths);

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
		await runSprilicredLogin({} as any, settings, "test-key", paths);
		const second = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(second.providers["sprilicred-anthropic"].models[0].cost.input).toBe(2);
		expect(second.providers["sprilicred-anthropic"].models[0].contextWindow).toBe(500000);
		expect(cfgModelRoles.get(settings).smol).toBe("other/keep");
		expect((await fs.readFile(tokenPath, "utf8")).trim()).toBe("test-key");
	});
});
