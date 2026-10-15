import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import {
	cfgAuthBrokerUrl,
	cfgCycleModels,
	cfgEnabledModels,
	cfgModelPresets,
	cfgModelProviderOrder,
	cfgModelRoles,
} from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSprilicredLogin } from "@oh-my-pi/pi-coding-agent/cli/sprilicred-login";
import { getModelPreset } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { cfgRetryFallbackChains, cfgRetryUsageLimitFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("SpriliCred login", () => {
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
		// Retired routes (glm, muse) list nothing, so an omp that still asks them writes no provider.
		dedicated = {
			deepseek: [{ id: "deepseek-v4.1-flash", context_window: 1000000, input_modalities: ["text", "image"] }],
			openrouter: [
				{
					id: "meta/muse-wonder",
					display_name: "Meta: Muse Wonder",
					context_window: 1048576,
					max_output_tokens: 128000,
					supports_reasoning: true,
					reasoning_efforts: ["none", "low", "high"],
					input_modalities: ["text", "image"],
					pricing: {
						unit: "microcredits_per_token",
						usd_per_microcredit: "0.000000001",
						input: 4000,
						output: 20000,
						cache_read: 200,
						cache_write: null,
					},
				},
				{ id: "openai/gpt-5", display_name: "OpenAI: GPT-5", context_window: 400000 },
			],
		};
		previousUrl = process.env.SPRILICRED_URL;
		process.env.SPRILICRED_URL = "https://sprilicred.test";
		originalFetch = globalThis.fetch;
		globalThis.fetch = (async input => {
			const route = /^https:\/\/sprilicred\.test\/(glm|deepseek|muse|openrouter)\/v1\/models$/.exec(
				String(input),
			)?.[1];
			if (route) {
				const listing = dedicated[route] ?? [];
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

	test("renames names an older login wrote as ' via Sprilicred' and keeps names the person chose", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		const paths = { home: root, agentDir, tokenPath };
		const modelsPath = path.join(agentDir, "models.yml");
		await fs.writeFile(modelsPath, JSON.stringify({ defaultModel: "sprilicred-openrouter/openai/gpt-5" }));
		await runSprilicredLogin({} as any, settings, "test-key", paths);
		const first = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		const anthropic = first.providers["sprilicred-anthropic"].models;
		const openrouter = first.providers["sprilicred-openrouter"].models;
		const generated = [anthropic[0].name, openrouter[0].name];
		expect(generated.every((name: string) => name.endsWith(" via SpriliCred"))).toBe(true);
		anthropic[0].name = anthropic[0].name.replace(/ via SpriliCred$/, " via Sprilicred");
		anthropic[1].name = "My own name";
		openrouter[0].name = openrouter[0].name.replace(/ via SpriliCred$/, " via Sprilicred");
		await fs.writeFile(modelsPath, JSON.stringify(first));
		await runSprilicredLogin({} as any, settings, "test-key", paths);
		const second = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		expect(second.providers["sprilicred-anthropic"].models[0].name).toBe(generated[0]);
		expect(second.providers["sprilicred-anthropic"].models[1].name).toBe("My own name");
		expect(second.providers["sprilicred-openrouter"].models[0].name).toBe(generated[1]);
	});
	const CYCLE = ["sprilicred-anthropic/*", "sprilicred-openai/*", "sprilicred-deepseek/*"];
	const OLD_CYCLE = [
		"sprilicred-anthropic/*",
		"sprilicred-openai/*",
		"sprilicred-glm/*",
		"sprilicred-deepseek/*",
		"sprilicred-muse/*",
	];
	const MUSE = "sprilicred-openrouter/meta/muse-wonder";
	// The key is supplied, so login never prompts on this interface.
	const noPrompt = {} as Parameters<typeof runSprilicredLogin>[0];

	test("puts DeepSeek under its own provider and writes no GLM provider, like the installer", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		const provider = written.providers["sprilicred-deepseek"];
		expect(provider).toMatchObject({
			baseUrl: "https://sprilicred.test/deepseek/v1",
			api: "openai-responses",
			auth: "apiKey",
			authHeader: true,
			apiKey: `!cat '${tokenPath}'`,
			discovery: { type: "openai-models-list", injectV1: false },
		});
		expect(provider.models.map((model: { id: string }) => model.id)).toEqual(["deepseek-v4.1-flash"]);
		expect(provider.models[0].compat).toEqual({ reasoningDisableMode: "none-effort" });
		expect(provider.models[0].input).toEqual(["text", "image"]);
		expect(written.providers["sprilicred-glm"]).toBeUndefined();
		expect(written.providers["sprilicred-muse"]).toBeUndefined();
		expect(written.providers["sprilicred-openai"].baseUrl).toBe("https://sprilicred.test/v1");
		expect(written.providers["sprilicred-openai"].models.map((model: { id: string }) => model.id)).toEqual([
			"gpt-6-astra",
		]);
		expect(Object.keys(written.providers)).toEqual([
			"other",
			"sprilicred-anthropic",
			"sprilicred-openai",
			"sprilicred-deepseek",
			"sprilicred-openrouter",
		]);
		// OpenRouter models are picked in /model; they never join Ctrl+P.
		expect(cfgCycleModels.get(settings)).toEqual(CYCLE);
	});

	test("writes the OpenRouter provider for the model browser and retires sprilicred-muse and GLM", async () => {
		const before = OLD_CYCLE;
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				defaultModel: "sprilicred-muse/muse-wonder:high",
				providers: {
					other: { models: [{ id: "keep" }] },
					"sprilicred-muse": {
						baseUrl: "https://sprilicred.test/muse/v1",
						models: [{ id: "muse-wonder", name: "Muse Wonder via SpriliCred" }],
					},
					"sprilicred-glm": {
						baseUrl: "https://sprilicred.test/glm/v1",
						models: [{ id: "abliterated-model-large-v2" }, { id: "my-glm" }],
					},
				},
			}),
		);
		await fs.mkdir(path.join(root, ".sprilicred"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".sprilicred/omp-models.json"),
			JSON.stringify({
				"sprilicred-muse/muse-wonder.listed": { present: false, before: null, applied: true },
				"sprilicred-glm/abliterated-model-large-v2.listed": { present: false, before: null, applied: true },
				"sprilicred-openai/abliterated-model-large-v2.contextWindow": { present: false, before: null, applied: 1 },
			}),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgCycleModels.set(settings, before);
		cfgEnabledModels.set(settings, [...before, "mine/*"]);
		cfgModelProviderOrder.set(settings, [...before.map(scope => scope.slice(0, -2)), "personal"]);
		cfgModelRoles.setEntry(settings, "plan", "sprilicred-openai/muse-wonder");
		cfgModelRoles.setEntry(settings, "commit", "sprilicred-glm/abliterated-model-large-v2");
		cfgModelRoles.setEntry(settings, "task", "sprilicred-openai/abliterated-model-large-v2:high");
		cfgRetryFallbackChains.set(settings, {
			"sprilicred-muse/muse-wonder": ["sprilicred-muse/muse-wonder:low", "other/keep"],
			"sprilicred-glm/my-glm": ["other/keep"],
			"other/keep": ["sprilicred-glm/abliterated-model-large-v2"],
		});
		cfgRetryUsageLimitFallbackChains.set(settings, {
			"sprilicred-anthropic/claude-sonnet-5": ["sprilicred-muse/muse-wonder"],
		});
		await settings.flush();
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });

		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(written.providers["sprilicred-muse"]).toBeUndefined();
		expect(written.providers["sprilicred-glm"]).toBeUndefined();
		expect(Object.keys(written.providers).at(-1)).toBe("sprilicred-openrouter");
		// A search in /model, not a discovered list. Its models are the person's, plus the entry
		// the moved Muse reference needs, built from the listing row; effort `none` is not omp's.
		expect(written.providers["sprilicred-openrouter"]).toEqual({
			baseUrl: "https://sprilicred.test/openrouter/v1",
			apiKey: `!cat '${tokenPath}'`,
			auth: "apiKey",
			authHeader: true,
			api: "openai-responses",
			modelSearch: { type: "openai-models-list", param: "search", limit: 25, label: "OpenRouter" },
			models: [
				{
					id: "meta/muse-wonder",
					name: "Meta: Muse Wonder via SpriliCred",
					contextWindow: 1048576,
					maxTokens: 128000,
					reasoning: true,
					thinking: { mode: "effort", efforts: ["low", "high"] },
					input: ["text", "image"],
					cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
				},
			],
		});
		expect(written.defaultModel).toBe(`${MUSE}:high`);
		const state = JSON.parse(await fs.readFile(path.join(root, ".sprilicred/omp-models.json"), "utf8"));
		expect(Object.keys(state).filter(key => /^sprilicred-(muse|glm)\/|abliterated-model-large-v2/.test(key))).toEqual(
			[],
		);

		// The installer's old default cycle becomes the new one; OpenRouter never joins Ctrl+P.
		expect(cfgCycleModels.get(settings)).toEqual(CYCLE);
		expect(cfgEnabledModels.get(settings)).toEqual([...CYCLE, "sprilicred-openrouter/**", "mine/*"]);
		expect(cfgModelProviderOrder.get(settings)).toEqual([
			...CYCLE.map(scope => scope.slice(0, -2)),
			"sprilicred-openrouter",
			"personal",
		]);
		expect(cfgModelRoles.get(settings).plan).toBe(MUSE);
		expect(cfgModelRoles.get(settings).commit).toBeUndefined();
		expect(cfgModelRoles.get(settings).task).toBeUndefined();
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ [MUSE]: [`${MUSE}:low`, "other/keep"] });
		expect(cfgRetryUsageLimitFallbackChains.get(settings)).toEqual({
			"sprilicred-anthropic/claude-sonnet-5": [MUSE],
		});

		// A later login respects a narrower list the person chose.
		cfgEnabledModels.set(settings, ["sprilicred-openai/*", "mine/*"]);
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		expect(cfgEnabledModels.get(settings)).toEqual(["sprilicred-openai/*", "mine/*"]);
	});

	test("keeps every Muse Wonder entry out of a custom cycle, scope or exact id", async () => {
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				providers: Object.fromEntries(
					["anthropic", "openai", "glm", "deepseek"].map(route => [`sprilicred-${route}`, { models: [] }]),
				),
			}),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgCycleModels.set(settings, [
			"other/keep",
			"sprilicred-openai/*",
			"sprilicred-muse/*",
			"sprilicred-muse/muse-wonder:high",
			`${MUSE}:high`,
		]);
		await settings.flush();
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		// Muse Wonder's old entries go; an OpenRouter entry the person put there themselves stays.
		expect(cfgCycleModels.get(settings)).toEqual(["other/keep", "sprilicred-openai/*", `${MUSE}:high`]);
	});

	test("rewrites an earlier discovery-shaped OpenRouter provider as the search, keeping the person's keys", async () => {
		const picked = { id: "openai/gpt-5", name: "Mine" };
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				providers: {
					"sprilicred-openrouter": {
						headers: { "X-Mine": "yes" },
						baseUrl: "https://sprilicred.test/openrouter/v1",
						discovery: { type: "openai-models-list", injectV1: false },
					},
				},
			}),
		);
		const paths = { home: root, agentDir, tokenPath };
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const modelsPath = path.join(agentDir, "models.yml");
		const first = JSON.parse(await fs.readFile(modelsPath, "utf8")).providers["sprilicred-openrouter"];
		expect(Object.keys(first)).toEqual([
			"headers",
			"baseUrl",
			"apiKey",
			"auth",
			"authHeader",
			"api",
			"modelSearch",
			"models",
		]);
		expect(first.models).toEqual([]);

		// A model picked in the search is the person's: kept as it is, never rebuilt.
		const written = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		written.providers["sprilicred-openrouter"].models = [picked];
		written.defaultModel = "sprilicred-openrouter/openai/gpt-5";
		await fs.writeFile(modelsPath, JSON.stringify(written));
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		expect(JSON.parse(await fs.readFile(modelsPath, "utf8")).providers["sprilicred-openrouter"].models).toEqual([
			picked,
		]);
	});

	test("gives a Muse role moved to OpenRouter its entry, built in when the listing is unknown", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgModelRoles.setEntry(settings, "plan", "sprilicred-muse/muse-wonder:high");
		await settings.flush();
		dedicated.openrouter = 503;
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		expect(cfgModelRoles.get(settings).plan).toBe(`${MUSE}:high`);
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(written.providers["sprilicred-openrouter"].models).toEqual([
			{
				id: "meta/muse-wonder",
				name: "Muse Wonder via SpriliCred",
				contextWindow: 1048576,
				maxTokens: 128000,
				reasoning: true,
				thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
				input: ["text", "image"],
			},
		]);
	});

	test("an OpenRouter default gets its entry: bare id when unknown, no thinking for listed null efforts", async () => {
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({ defaultModel: "sprilicred-openrouter/openai/gpt-5:high" }),
		);
		const paths = { home: root, agentDir, tokenPath };
		const modelsPath = path.join(agentDir, "models.yml");
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		dedicated.openrouter = 503;
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		expect(JSON.parse(await fs.readFile(modelsPath, "utf8")).providers["sprilicred-openrouter"].models).toEqual([
			{ id: "openai/gpt-5", name: "openai/gpt-5 via SpriliCred" },
		]);

		const written = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		written.providers["sprilicred-openrouter"].models = [];
		await fs.writeFile(modelsPath, JSON.stringify(written));
		dedicated.openrouter = [
			{ id: "meta/muse-wonder" },
			{
				id: "openai/gpt-5",
				display_name: "OpenAI: GPT-5",
				context_window: 400000,
				max_output_tokens: 128000,
				supports_reasoning: true,
				reasoning_efforts: null,
			},
		];
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		expect(JSON.parse(await fs.readFile(modelsPath, "utf8")).providers["sprilicred-openrouter"].models).toEqual([
			{
				id: "openai/gpt-5",
				name: "OpenAI: GPT-5 via SpriliCred",
				contextWindow: 400000,
				maxTokens: 128000,
				reasoning: true,
			},
		]);
	});

	test("withdraws Muse when the OpenRouter listing names models but not Muse Wonder", async () => {
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({ defaultModel: "sprilicred-muse/muse-wonder:high" }),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgModelRoles.setEntry(settings, "plan", "muse-wonder");
		await settings.flush();
		dedicated.openrouter = [{ id: "openai/gpt-5" }];
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(written.defaultModel).toBe("sprilicred-anthropic/claude-sonnet-5");
		expect(written.providers["sprilicred-openrouter"].models).toEqual([]);
		expect(cfgModelRoles.get(settings).plan).toBeUndefined();
	});

	test("keeps duplicates the person wrote in a list, as the installer does", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgEnabledModels.set(settings, ["mine/*", "mine/*"]);
		await settings.flush();
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		expect(cfgEnabledModels.get(settings)).toEqual(["mine/*", "mine/*", "sprilicred-openrouter/**"]);
	});

	test("keeps a listed or unverifiable OpenRouter default, and drops the provider when nothing is listed", async () => {
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({ defaultModel: "sprilicred-openrouter/openai/gpt-5:high" }),
		);
		const paths = { home: root, agentDir, tokenPath };
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgEnabledModels.set(settings, ["sprilicred-openai/*"]);
		await settings.flush();
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const modelsPath = path.join(agentDir, "models.yml");
		expect(JSON.parse(await fs.readFile(modelsPath, "utf8")).defaultModel).toBe(
			"sprilicred-openrouter/openai/gpt-5:high",
		);
		const granted = ["sprilicred-openai/*", "sprilicred-deepseek/*", "sprilicred-openrouter/**"];
		expect(cfgEnabledModels.get(settings)).toEqual(granted);
		cfgModelRoles.setEntry(settings, "plan", "sprilicred-openrouter/openai/gpt-5");
		cfgModelRoles.setEntry(settings, "commit", "sprilicred-deepseek/deepseek-v4.1-flash");
		await settings.flush();

		// Unreachable listings (5xx, network): keep both providers, the person's own fields, scopes and roles.
		const kept = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		kept.providers["sprilicred-openrouter"].headers = { "X-Mine": "yes" };
		await fs.writeFile(modelsPath, JSON.stringify(kept));
		dedicated.openrouter = 503;
		dedicated.deepseek = 502;
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const unknown = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		expect(unknown.providers["sprilicred-openrouter"]).toMatchObject({
			headers: { "X-Mine": "yes" },
			baseUrl: "https://sprilicred.test/openrouter/v1",
		});
		expect(unknown.providers["sprilicred-deepseek"].models.map((model: { id: string }) => model.id)).toEqual([
			"deepseek-v4.1-flash",
		]);
		expect(unknown.defaultModel).toBe("sprilicred-openrouter/openai/gpt-5:high");
		expect(cfgEnabledModels.get(settings)).toEqual(granted);
		expect(cfgCycleModels.get(settings)).toEqual(CYCLE);
		expect(cfgModelRoles.get(settings).plan).toBe("sprilicred-openrouter/openai/gpt-5");
		expect(cfgModelRoles.get(settings).commit).toBe("sprilicred-deepseek/deepseek-v4.1-flash");

		// Listed without it: the default is gone like any other withdrawn model.
		dedicated.openrouter = [{ id: "meta/muse-wonder" }];
		dedicated.deepseek = [{ id: "deepseek-v4.1-flash" }];
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		expect(JSON.parse(await fs.readFile(modelsPath, "utf8")).defaultModel).toBe(
			"sprilicred-anthropic/claude-sonnet-5",
		);
	});

	const refusals: [string, number | unknown[]][] = [
		["empty listings", []],
		["403 listings", 403],
	];
	for (const [label, refusal] of refusals) {
		test(`without an API-key grant (${label}) drops OpenRouter, DeepSeek and Muse with every reference`, async () => {
			await fs.writeFile(
				path.join(agentDir, "models.yml"),
				JSON.stringify({
					defaultModel: "sprilicred-muse/muse-wonder",
					providers: {
						other: { models: [{ id: "keep" }] },
						"sprilicred-muse": { baseUrl: "https://sprilicred.test/muse/v1", models: [{ id: "muse-wonder" }] },
						"sprilicred-deepseek": {
							baseUrl: "https://sprilicred.test/deepseek/v1",
							models: [{ id: "deepseek-v4.1-flash" }, { id: "my-deepseek", name: "Mine" }],
						},
						"sprilicred-openrouter": { baseUrl: "https://sprilicred.test/openrouter/v1" },
					},
				}),
			);
			await fs.mkdir(path.join(root, ".sprilicred"), { recursive: true });
			await fs.writeFile(
				path.join(root, ".sprilicred/omp-roles.json"),
				JSON.stringify({ roles: { slow: "sprilicred-deepseek/deepseek-v4.1-flash" } }),
			);
			const settings = await Settings.loadIsolated({ agentDir, cwd: root });
			// The installer's last default cycle is ours: it becomes the default without DeepSeek.
			cfgCycleModels.set(settings, CYCLE);
			cfgEnabledModels.set(settings, [
				"sprilicred-anthropic/*",
				"sprilicred-openai/*",
				"sprilicred-deepseek/*",
				"sprilicred-muse/*",
				"sprilicred-openrouter/**",
			]);
			// A list withdrawal empties goes back to omp's default.
			cfgModelProviderOrder.set(settings, ["sprilicred-deepseek", "sprilicred-openrouter"]);
			cfgModelRoles.setEntry(settings, "plan", "sprilicred-muse/muse-wonder:high");
			cfgModelRoles.setEntry(settings, "commit", "sprilicred-openrouter/openai/gpt-5");
			cfgModelRoles.setEntry(settings, "task", "sprilicred-openai/deepseek-v4.1-flash");
			cfgModelRoles.setEntry(settings, "slow", "sprilicred-deepseek/deepseek-v4.1-flash");
			cfgRetryFallbackChains.set(settings, {
				"sprilicred-anthropic/claude-sonnet-5": ["sprilicred-deepseek/my-deepseek", "other/keep"],
				"sprilicred-openrouter/openai/gpt-5": ["other/keep"],
				"other/keep": ["sprilicred-openrouter/meta/muse-wonder"],
			});
			await settings.flush();
			dedicated.openrouter = refusal;
			dedicated.deepseek = refusal;
			const output: string[] = [];
			const write = process.stdout.write;
			process.stdout.write = ((chunk: string) => output.push(chunk) > 0) as typeof process.stdout.write;
			try {
				await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
			} finally {
				process.stdout.write = write;
			}

			const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
			expect(Object.keys(written.providers)).toEqual(["other", "sprilicred-anthropic", "sprilicred-openai"]);
			expect(written.defaultModel).toBe("sprilicred-anthropic/claude-sonnet-5");
			expect(cfgCycleModels.get(settings)).toEqual(["sprilicred-anthropic/*", "sprilicred-openai/*"]);
			expect(cfgEnabledModels.get(settings)).toEqual(["sprilicred-anthropic/*", "sprilicred-openai/*"]);
			expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).not.toContain("modelProviderOrder");
			expect(cfgModelProviderOrder.get(settings)).toEqual([]);
			const roles = cfgModelRoles.get(settings);
			expect(roles.plan).toBeUndefined();
			expect(roles.commit).toBeUndefined();
			expect(roles.task).toBeUndefined();
			// Owned by the last login: re-pinned rather than removed.
			expect(roles.slow).toBe("sprilicred-openai/gpt-6-astra");
			expect(cfgRetryFallbackChains.get(settings)).toEqual({
				"sprilicred-anthropic/claude-sonnet-5": ["other/keep"],
			});
			const text = output.join("");
			expect(text).toContain("Your default model sprilicred-muse/muse-wonder is no longer offered to you");
			expect(text).toContain("modelRoles.commit=sprilicred-openrouter/openai/gpt-5");
			expect(text).not.toContain("modelRoles.slow=");
		});
	}

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

	test("resets a GLM default and migrates only moved custom cycle refs", async () => {
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({ defaultModel: "sprilicred-glm/abliterated-model-large-v2" }),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgCycleModels.set(settings, [
			"other/keep",
			"sprilicred-openai/deepseek-v4.1-flash:high",
			"sprilicred-openai/abliterated-model-large-v2",
			"sprilicred-glm/*",
		]);
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(written.defaultModel).toBe("sprilicred-anthropic/claude-sonnet-5");
		expect(cfgCycleModels.get(settings)).toEqual(["other/keep", "sprilicred-deepseek/deepseek-v4.1-flash:high"]);
	});

	test("a custom cycle that withdrawal empties gets the installer default", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgCycleModels.set(settings, ["sprilicred-glm/*", "sprilicred-muse/muse-wonder"]);
		await settings.flush();
		dedicated.openrouter = [];
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		expect(cfgCycleModels.get(settings)).toEqual(CYCLE);
	});

	test("keeps the DeepSeek provider when its listing cannot be fetched", async () => {
		const paths = { home: root, agentDir, tokenPath };
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		dedicated.deepseek = 503;
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(written.providers["sprilicred-deepseek"].models[0].id).toBe("deepseek-v4.1-flash");
		expect(cfgCycleModels.get(settings)).toEqual(CYCLE);
	});

	test("keeps custom DeepSeek models the person added while DeepSeek is listed", async () => {
		const paths = { home: root, agentDir, tokenPath };
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const modelsPath = path.join(agentDir, "models.yml");
		const existing = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		const custom = { id: "my-deepseek", name: "Personal DeepSeek", headers: { "X-Custom": "yes" } };
		existing.providers["sprilicred-deepseek"].models.push(custom);
		await fs.writeFile(modelsPath, JSON.stringify(existing));
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const written = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		expect(written.providers["sprilicred-deepseek"].models.at(-1)).toEqual(custom);
	});

	test("writes the Claude effort ladder and Codex none-effort like the installer, keeping user edits", async () => {
		const baseFetch = globalThis.fetch;
		globalThis.fetch = (async (input, init) => {
			const response = await baseFetch(input, init);
			if (!/^https:\/\/sprilicred\.test\/v1\/models$/.test(String(input))) return response;
			const { data } = (await response.json()) as { data: unknown[] };
			return Response.json({ data: [...data, { id: "gpt-7-nova", context_window: 272000 }] });
		}) as typeof fetch;
		const paths = { home: root, agentDir, tokenPath };
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const modelsPath = path.join(agentDir, "models.yml");
		const first = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		const claude = Object.fromEntries(
			first.providers["sprilicred-anthropic"].models.map((model: { id: string }) => [model.id, model]),
		);
		// No listed efforts: the installer's built-in ladder for the id, none for a budget model.
		expect(claude["claude-sonnet-5"].thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: ["low", "medium", "high", "xhigh", "max"],
		});
		expect(claude["claude-haiku-4-5"].thinking).toBeUndefined();
		const openai = Object.fromEntries(
			first.providers["sprilicred-openai"].models.map((model: { id: string }) => [model.id, model]),
		);
		expect(openai["gpt-6-astra"].compat).toEqual({ reasoningDisableMode: "none-effort" });
		// Never guessed for an id the installer does not know.
		expect(openai["gpt-7-nova"].compat).toBeUndefined();

		claude["claude-sonnet-5"].thinking = { mode: "anthropic-adaptive", efforts: ["high"] };
		openai["gpt-6-astra"].compat = { reasoningDisableMode: "omit" };
		await fs.writeFile(modelsPath, JSON.stringify(first));
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const second = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		expect(second.providers["sprilicred-anthropic"].models[1].thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: ["high"],
		});
		expect(second.providers["sprilicred-openai"].models[0].compat).toEqual({ reasoningDisableMode: "omit" });
	});

	test("adds OpenRouter to lists the person set without the sprilicred-openai scope, never to a cycle", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgCycleModels.set(settings, ["other/keep"]);
		cfgEnabledModels.set(settings, ["mine/*"]);
		cfgModelProviderOrder.set(settings, ["personal"]);
		await settings.flush();
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		// DeepSeek joins only a list holding the sprilicred-openai scope.
		expect(cfgCycleModels.get(settings)).toEqual(["other/keep"]);
		expect(cfgEnabledModels.get(settings)).toEqual(["mine/*", "sprilicred-openrouter/**"]);
		expect(cfgModelProviderOrder.get(settings)).toEqual(["personal", "sprilicred-openrouter"]);
	});

	test("puts OpenRouter after the person's last SpriliCred entry when the list has no SpriliCred group", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgEnabledModels.set(settings, ["sprilicred-anthropic/*", "mine/*"]);
		cfgModelProviderOrder.set(settings, ["sprilicred-anthropic", "personal"]);
		await settings.flush();
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		expect(cfgEnabledModels.get(settings)).toEqual(["sprilicred-anthropic/*", "sprilicred-openrouter/**", "mine/*"]);
		expect(cfgModelProviderOrder.get(settings)).toEqual([
			"sprilicred-anthropic",
			"sprilicred-openrouter",
			"personal",
		]);
	});

	test("migrates or withdraws bare model ids like provider-qualified ones", async () => {
		await fs.writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ defaultModel: "muse-wonder:high" }));
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgModelRoles.setEntry(settings, "plan", "muse-wonder");
		cfgModelRoles.setEntry(settings, "commit", "abliterated-model-large-v2:low");
		cfgModelRoles.setEntry(settings, "task", "deepseek-v4.1-flash");
		cfgRetryFallbackChains.set(settings, {
			"muse-wonder:high": ["deepseek-v4.1-flash", "abliterated-model-large-v2"],
			"abliterated-model-large-v2": ["other/keep"],
		});
		await settings.flush();
		const paths = { home: root, agentDir, tokenPath };
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		expect(JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8")).defaultModel).toBe(
			`${MUSE}:high`,
		);
		expect(cfgModelRoles.get(settings).plan).toBe(MUSE);
		expect(cfgModelRoles.get(settings).commit).toBeUndefined();
		expect(cfgModelRoles.get(settings).task).toBe("deepseek-v4.1-flash");
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ [`${MUSE}:high`]: ["deepseek-v4.1-flash"] });

		// Without a grant the bare DeepSeek id goes too, and the default falls back like a qualified one.
		dedicated.openrouter = [];
		dedicated.deepseek = [];
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		expect(JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8")).defaultModel).toBe(
			"sprilicred-anthropic/claude-sonnet-5",
		);
		expect(cfgModelRoles.get(settings).task).toBeUndefined();
		expect(cfgRetryFallbackChains.get(settings)).toEqual({});
	});

	test("a migrated fallback chain never replaces the one already under its new key", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		for (const chains of [cfgRetryFallbackChains, cfgRetryUsageLimitFallbackChains]) {
			chains.set(settings, {
				// The person's own chain comes first, so the legacy one would overwrite it.
				[MUSE]: ["other/keep"],
				"sprilicred-muse/muse-wonder": ["sprilicred-openai/gpt-6-astra"],
			});
		}
		await settings.flush();
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ [MUSE]: ["other/keep"] });
		expect(cfgRetryUsageLimitFallbackChains.get(settings)).toEqual({ [MUSE]: ["other/keep"] });
	});

	test("migrates the role maps of global model presets and leaves project presets in their file", async () => {
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			[
				"modelPresets:",
				"  mine:",
				"    defaultThinkingLevel: high",
				"    modelRoles:",
				"      default: sprilicred-muse/muse-wonder:high",
				"      plan: sprilicred-glm/abliterated-model-large-v2",
				"      smol: other/keep",
				"",
			].join("\n"),
		);
		await fs.mkdir(path.join(root, ".omp"), { recursive: true });
		const project =
			"modelPresets:\n  team:\n    modelRoles:\n      default: sprilicred-glm/abliterated-model-large-v2\n";
		await fs.writeFile(path.join(root, ".omp", "config.yml"), project);
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		expect(getModelPreset(settings, "mine")).toEqual({
			kind: "found",
			preset: { defaultThinkingLevel: Effort.High, modelRoles: { default: `${MUSE}:high`, smol: "other/keep" } },
		});
		const global = await fs.readFile(path.join(agentDir, "config.yml"), "utf8");
		expect(global).not.toContain("team");
		expect(global).not.toContain("sprilicred-glm");
		expect(await fs.readFile(path.join(root, ".omp", "config.yml"), "utf8")).toBe(project);
	});

	test("fills a standard role the migration emptied in the same login", async () => {
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgModelRoles.setEntry(settings, "slow", "sprilicred-glm/abliterated-model-large-v2");
		await settings.flush();
		const paths = { home: root, agentDir, tokenPath };
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const first = await fs.readFile(path.join(agentDir, "config.yml"), "utf8");
		expect(cfgModelRoles.get(settings).slow).toBe("sprilicred-openai/gpt-6-astra");
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).toBe(first);
	});

	// Each case is deploy/fixtures/omp-parity/<case> from SpriliCred's installer (deploy/connect.py,
	// naming-spriliCred 6fbdb99), written by install_omp from the same listings and the same
	// before-files: catalog.json (listing bodies per route), models/config/state.before.json
	// (migration cases), installer-{models,config,state}.json. `$HOME` is the scratch home and
	// https://sprilicred.example the server.
	// Every case the installer recorded, so a new one is never skipped.
	const PARITY_DIR = path.join(import.meta.dir, "fixtures", "sprilicred-login-parity");
	for (const parityCase of readdirSync(PARITY_DIR).sort()) {
		test(`writes what the SpriliCred installer writes: ${parityCase}`, async () => {
			const dir = path.join(import.meta.dir, "fixtures", "sprilicred-login-parity", parityCase);
			const load = async (name: string) => {
				const file = path.join(dir, name);
				if (!(await Bun.file(file).exists())) return undefined;
				return JSON.parse((await fs.readFile(file, "utf8")).replaceAll("$HOME", root));
			};
			const catalog = await load("catalog.json");
			process.env.SPRILICRED_URL = "https://sprilicred.example";
			globalThis.fetch = (async input => {
				const body = catalog[String(input).replace("https://sprilicred.example", "")];
				return body ? Response.json(body) : new Response("no", { status: 404 });
			}) as typeof fetch;
			const modelsBefore = await load("models.before.json");
			if (modelsBefore) await fs.writeFile(path.join(agentDir, "models.yml"), JSON.stringify(modelsBefore));
			else await fs.rm(path.join(agentDir, "models.yml"));
			const stateBefore = (await load("state.before.json")) ?? {};
			for (const [file, content] of Object.entries(stateBefore)) {
				await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
				await fs.writeFile(path.join(root, file), JSON.stringify(content));
			}
			const lists = {
				cycleModels: cfgCycleModels,
				enabledModels: cfgEnabledModels,
				modelProviderOrder: cfgModelProviderOrder,
			};
			const chains = {
				"retry.fallbackChains": cfgRetryFallbackChains,
				"retry.usageLimitFallbackChains": cfgRetryUsageLimitFallbackChains,
			};
			const settings = await Settings.loadIsolated({ agentDir, cwd: root });
			const configBefore = await load("config.before.json");
			if (configBefore) {
				for (const [name, setting] of Object.entries(lists)) {
					if (configBefore[name]?.length) setting.set(settings, configBefore[name]);
				}
				for (const [name, setting] of Object.entries(chains)) {
					if (Object.keys(configBefore[name] ?? {}).length) setting.set(settings, configBefore[name]);
				}
				cfgModelRoles.set(settings, configBefore.modelRoles ?? {});
				cfgModelPresets.set(settings, configBefore.modelPresets ?? {});
				if (configBefore["auth.broker.url"]) cfgAuthBrokerUrl.set(settings, configBefore["auth.broker.url"]);
				await settings.flush();
			}

			await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });

			// This branch reads the key from the broker token file; the installer from ~/.sprilicred/user.key.
			const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
			for (const provider of Object.values(written.providers) as { apiKey?: string }[]) {
				if (provider.apiKey === `!cat '${tokenPath}'`) provider.apiKey = `!cat '${root}/.sprilicred/user.key'`;
			}
			// Key order too: the same document, not just equal values.
			expect(JSON.stringify(written, null, 2)).toBe(JSON.stringify(await load("installer-models.json"), null, 2));

			const expectedConfig = await load("installer-config.json");
			delete expectedConfig["auth.broker.token"];
			expect({
				"auth.broker.url": cfgAuthBrokerUrl.get(settings),
				...Object.fromEntries(Object.entries(lists).map(([name, setting]) => [name, setting.get(settings)])),
				modelRoles: cfgModelRoles.get(settings),
				modelPresets: cfgModelPresets.get(settings),
				...Object.fromEntries(Object.entries(chains).map(([name, setting]) => [name, setting.get(settings)])),
			}).toEqual(expectedConfig);

			// omp-models.json's defaultModel and providerScopes records are the installer's own
			// bookkeeping (its --model choice and a resumable scope migration). omp keeps neither and
			// passes them through untouched, so they are compared against the before-state.
			const expectedState = await load("installer-state.json");
			for (const [file, content] of Object.entries(expectedState) as [string, Record<string, unknown>][]) {
				const actual = JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
				if (file === ".sprilicred/omp-models.json") {
					const before = (stateBefore[file] ?? {}) as Record<string, unknown>;
					for (const key of ["defaultModel", "providerScopes"]) {
						if (key in before) content[key] = before[key];
						else delete content[key];
					}
				}
				expect({ [file]: actual }).toEqual({ [file]: content });
			}
		});
	}
});
