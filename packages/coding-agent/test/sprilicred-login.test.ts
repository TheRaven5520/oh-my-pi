import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cfgCycleModels, cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSprilicredLogin } from "@oh-my-pi/pi-coding-agent/cli/sprilicred-login";

describe("Sprilicred login", () => {
	let root: string;
	let agentDir: string;
	let tokenPath: string;
	let price: number;
	let originalFetch: typeof fetch;
	let previousUrl: string | undefined;
	let dedicated: Record<string, unknown[] | number>;

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
		dedicated = {
			glm: [
				{
					id: "abliterated-model-large-v2",
					display_name: "GLM 5.3 Abliterated",
					context_window: 200000,
					input_modalities: ["text"],
				},
			],
			deepseek: [{ id: "deepseek-v4.1-flash", context_window: 1000000, input_modalities: ["text", "image"] }],
		};
		previousUrl = process.env.SPRILICRED_URL;
		process.env.SPRILICRED_URL = "https://sprilicred.test";
		originalFetch = globalThis.fetch;
		globalThis.fetch = (async input => {
			const route = /^https:\/\/sprilicred\.test\/(glm|deepseek)\/v1\/models$/.exec(String(input))?.[1];
			if (route) {
				const listing = dedicated[route];
				return typeof listing === "number"
					? new Response("no", { status: listing })
					: Response.json({ data: listing });
			}
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
							// Older listings also carried a dedicated model on /v1.
							{ id: "deepseek-v4.1-flash", context_window: 1000000 },
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

	const CYCLE = ["sprilicred-anthropic/*", "sprilicred-openai/*", "sprilicred-glm/*", "sprilicred-deepseek/*"];
	// The key is supplied, so login never prompts on this interface.
	const noPrompt = {} as Parameters<typeof runSprilicredLogin>[0];

	test("puts GLM and DeepSeek under their own providers like the installer", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		const tokenCommand = `!cat '${tokenPath}'`;
		for (const [route, id] of [
			["glm", "abliterated-model-large-v2"],
			["deepseek", "deepseek-v4.1-flash"],
		]) {
			const provider = written.providers[`sprilicred-${route}`];
			expect(provider).toMatchObject({
				baseUrl: `https://sprilicred.test/${route}/v1`,
				api: "openai-responses",
				auth: "apiKey",
				authHeader: true,
				apiKey: tokenCommand,
				discovery: { type: "openai-models-list", injectV1: false },
			});
			expect(provider.models.map((model: { id: string }) => model.id)).toEqual([id]);
			expect(provider.models[0].compat).toEqual({ reasoningDisableMode: "none-effort" });
		}
		expect(written.providers["sprilicred-glm"].models[0].input).toEqual(["text"]);
		expect(written.providers["sprilicred-glm"].models[0].name).toBe("GLM 5.3 Abliterated via Sprilicred");
		expect(written.providers["sprilicred-deepseek"].models[0].input).toEqual(["text", "image"]);
		expect(written.providers["sprilicred-openai"].baseUrl).toBe("https://sprilicred.test/v1");
		expect(written.providers["sprilicred-openai"].models.map((model: { id: string }) => model.id)).toEqual([
			"gpt-6-astra",
		]);
		expect(cfgCycleModels.get(settings)).toEqual(CYCLE);
	});

	test("moves old sprilicred-openai refs and the old owned cycle list to the new layout", async () => {
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				defaultModel: "sprilicred-openai/deepseek-v4.1-flash:high",
				providers: {
					"sprilicred-openai": { models: [{ id: "deepseek-v4.1-flash", name: "My DeepSeek" }] },
					"sprilicred-glm": { models: [{ id: "stale-glm" }] },
				},
			}),
		);
		await fs.mkdir(path.join(root, ".sprilicred"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".sprilicred/omp-models.json"),
			JSON.stringify({ "sprilicred-glm/stale-glm.listed": { present: false, before: null, applied: true } }),
		);
		dedicated.glm = [];
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgCycleModels.set(settings, ["sprilicred-anthropic/*", "sprilicred-openai/*"]);
		cfgModelRoles.setEntry(settings, "plan", "sprilicred-openai/deepseek-v4.1-flash");
		await settings.flush();
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(written.defaultModel).toBe("sprilicred-deepseek/deepseek-v4.1-flash:high");
		expect(written.providers["sprilicred-deepseek"].models[0].name).toBe("My DeepSeek");
		expect(written.providers["sprilicred-glm"]).toBeUndefined();
		expect(cfgModelRoles.get(settings).plan).toBe("sprilicred-deepseek/deepseek-v4.1-flash");
		expect(cfgCycleModels.get(settings)).toEqual(CYCLE);
	});

	test("preserves dedicated defaults and migrates only moved custom cycle refs", async () => {
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({ defaultModel: "sprilicred-glm/abliterated-model-large-v2" }),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgCycleModels.set(settings, ["other/keep", "sprilicred-openai/deepseek-v4.1-flash:high"]);
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(written.defaultModel).toBe("sprilicred-glm/abliterated-model-large-v2");
		expect(cfgCycleModels.get(settings)).toEqual(["other/keep", "sprilicred-deepseek/deepseek-v4.1-flash:high"]);
	});

	test("keeps a dedicated provider when its listing cannot be fetched", async () => {
		const paths = { home: root, agentDir, tokenPath };
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		dedicated.glm = 503;
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(written.providers["sprilicred-glm"].models[0].id).toBe("abliterated-model-large-v2");
	});

	test("keeps custom dedicated models when the managed catalog becomes empty", async () => {
		const paths = { home: root, agentDir, tokenPath };
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const modelsPath = path.join(agentDir, "models.yml");
		const existing = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		const custom = { id: "my-glm", name: "Personal GLM", contextWindow: 12345, headers: { "X-Custom": "yes" } };
		existing.providers["sprilicred-glm"].models.push(custom);
		existing.defaultModel = "sprilicred-glm/my-glm";
		await fs.writeFile(modelsPath, JSON.stringify(existing));
		const customCycle = ["sprilicred-anthropic/*", "sprilicred-openai/*", "sprilicred-deepseek/*"];
		cfgCycleModels.set(settings, customCycle);
		dedicated.glm = [];
		dedicated.deepseek = [];
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const written = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		expect(written.providers["sprilicred-glm"].models).toEqual([custom]);
		expect(written.providers["sprilicred-glm"].baseUrl).toBe("https://sprilicred.test/glm/v1");
		expect(written.providers["sprilicred-deepseek"]).toBeUndefined();
		expect(written.defaultModel).toBe("sprilicred-glm/my-glm");
		expect(cfgCycleModels.get(settings)).toEqual(customCycle);
	});
});
