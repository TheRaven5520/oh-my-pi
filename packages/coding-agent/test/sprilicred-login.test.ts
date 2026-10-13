import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cfgCycleModels,
	cfgEnabledModels,
	cfgModelProviderOrder,
	cfgModelRoles,
} from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSprilicredLogin } from "@oh-my-pi/pi-coding-agent/cli/sprilicred-login";
import { cfgRetryFallbackChains, cfgRetryUsageLimitFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";

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
			openrouter: [
				{
					id: "meta/muse-wonder",
					display_name: "Meta: Muse Wonder",
					context_window: 1048576,
					max_output_tokens: 128000,
					supports_reasoning: true,
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
			const route = /^https:\/\/sprilicred\.test\/(glm|deepseek|openrouter)\/v1\/models$/.exec(String(input))?.[1];
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
	const MUSE = "sprilicred-openrouter/meta/muse-wonder";
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

	test("writes the OpenRouter provider for the model browser and retires sprilicred-muse", async () => {
		const before = ["sprilicred-anthropic/*", ...CYCLE.slice(1), "sprilicred-muse/*"];
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				defaultModel: "sprilicred-muse/muse-wonder:high",
				providers: {
					other: { models: [{ id: "keep" }] },
					"sprilicred-muse": {
						baseUrl: "https://sprilicred.test/muse/v1",
						models: [{ id: "muse-wonder", name: "Muse Wonder via Sprilicred" }],
					},
				},
			}),
		);
		await fs.mkdir(path.join(root, ".sprilicred"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".sprilicred/omp-models.json"),
			JSON.stringify({ "sprilicred-muse/muse-wonder.listed": { present: false, before: null, applied: true } }),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		cfgCycleModels.set(settings, before);
		cfgEnabledModels.set(settings, [...before, "mine/*"]);
		cfgModelProviderOrder.set(settings, [...before.map(scope => scope.slice(0, -2)), "personal"]);
		cfgModelRoles.setEntry(settings, "plan", "sprilicred-openai/muse-wonder");
		cfgRetryFallbackChains.set(settings, {
			"sprilicred-muse/muse-wonder": ["sprilicred-muse/muse-wonder:low", "other/keep"],
		});
		cfgRetryUsageLimitFallbackChains.set(settings, {
			"sprilicred-anthropic/claude-sonnet-5": ["sprilicred-muse/muse-wonder"],
		});
		await settings.flush();
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });

		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(written.providers["sprilicred-muse"]).toBeUndefined();
		expect(Object.keys(written.providers).at(-1)).toBe("sprilicred-openrouter");
		// No model list: discovery reads the listing, so the browser always shows the current catalog.
		expect(written.providers["sprilicred-openrouter"]).toEqual({
			baseUrl: "https://sprilicred.test/openrouter/v1",
			apiKey: `!cat '${tokenPath}'`,
			auth: "apiKey",
			authHeader: true,
			api: "openai-responses",
			discovery: { type: "openai-models-list", injectV1: false },
		});
		expect(written.defaultModel).toBe(`${MUSE}:high`);
		const state = JSON.parse(await fs.readFile(path.join(root, ".sprilicred/omp-models.json"), "utf8"));
		expect(Object.keys(state).filter(key => key.startsWith("sprilicred-muse/"))).toEqual([]);

		// The installer's old default cycle becomes the new one; OpenRouter never joins Ctrl+P.
		expect(cfgCycleModels.get(settings)).toEqual(CYCLE);
		expect(cfgEnabledModels.get(settings)).toEqual([...CYCLE, "sprilicred-openrouter/**", "mine/*"]);
		expect(cfgModelProviderOrder.get(settings)).toEqual([
			...CYCLE.map(scope => scope.slice(0, -2)),
			"sprilicred-openrouter",
			"personal",
		]);
		expect(cfgModelRoles.get(settings).plan).toBe(MUSE);
		expect(cfgRetryFallbackChains.get(settings)).toEqual({ [MUSE]: [`${MUSE}:low`, "other/keep"] });
		expect(cfgRetryUsageLimitFallbackChains.get(settings)).toEqual({
			"sprilicred-anthropic/claude-sonnet-5": [MUSE],
		});

		// A later login respects a narrower list the person chose.
		cfgEnabledModels.set(settings, ["sprilicred-openai/*", "mine/*"]);
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		expect(cfgEnabledModels.get(settings)).toEqual(["sprilicred-openai/*", "mine/*"]);
	});

	test("keeps a custom cycle free of OpenRouter, pinning Muse Wonder by its exact id", async () => {
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
		expect(cfgCycleModels.get(settings)).toEqual(["other/keep", "sprilicred-openai/*", MUSE, `${MUSE}:high`]);
	});

	test("keeps a listed or unverifiable OpenRouter default, and drops the provider when nothing is listed", async () => {
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({ defaultModel: "sprilicred-openrouter/openai/gpt-5:high" }),
		);
		const paths = { home: root, agentDir, tokenPath };
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const modelsPath = path.join(agentDir, "models.yml");
		expect(JSON.parse(await fs.readFile(modelsPath, "utf8")).defaultModel).toBe(
			"sprilicred-openrouter/openai/gpt-5:high",
		);

		// Unreachable listing: keep the provider (and the person's own fields).
		const kept = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		kept.providers["sprilicred-openrouter"].headers = { "X-Mine": "yes" };
		await fs.writeFile(modelsPath, JSON.stringify(kept));
		dedicated.openrouter = 503;
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const unknown = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		expect(unknown.providers["sprilicred-openrouter"]).toMatchObject({
			headers: { "X-Mine": "yes" },
			baseUrl: "https://sprilicred.test/openrouter/v1",
		});
		expect(unknown.defaultModel).toBe("sprilicred-openrouter/openai/gpt-5:high");

		// Listed without it: the default is gone like any other withdrawn model.
		dedicated.openrouter = [{ id: "meta/muse-wonder" }];
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		expect(JSON.parse(await fs.readFile(modelsPath, "utf8")).defaultModel).toStartWith("sprilicred-anthropic/");

		dedicated.openrouter = [];
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		expect(JSON.parse(await fs.readFile(modelsPath, "utf8")).providers["sprilicred-openrouter"]).toBeUndefined();
	});

	test("leaves Muse Wonder where it is when the server does not offer OpenRouter", async () => {
		const museProvider = { baseUrl: "https://sprilicred.test/muse/v1", models: [{ id: "muse-wonder" }] };
		await fs.writeFile(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				defaultModel: "sprilicred-muse/muse-wonder",
				providers: { "sprilicred-muse": museProvider },
			}),
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		const muselist = ["sprilicred-anthropic/*", "sprilicred-openai/*", "sprilicred-muse/*"];
		cfgEnabledModels.set(settings, muselist);
		cfgModelRoles.setEntry(settings, "plan", "sprilicred-muse/muse-wonder:high");
		await settings.flush();
		dedicated.openrouter = 404;
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		expect(written.providers["sprilicred-openrouter"]).toBeUndefined();
		expect(written.providers["sprilicred-muse"]).toEqual(museProvider);
		expect(written.defaultModel).toBe("sprilicred-muse/muse-wonder");
		expect(cfgEnabledModels.get(settings)).toEqual([
			...muselist.slice(0, 2),
			"sprilicred-glm/*",
			"sprilicred-deepseek/*",
			"sprilicred-muse/*",
		]);
		expect(cfgModelRoles.get(settings).plan).toBe("sprilicred-muse/muse-wonder:high");
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
		dedicated.openrouter = [];
		await runSprilicredLogin(noPrompt, settings, "test-key", paths);
		const written = JSON.parse(await fs.readFile(modelsPath, "utf8"));
		expect(written.providers["sprilicred-glm"].models).toEqual([custom]);
		expect(written.providers["sprilicred-glm"].baseUrl).toBe("https://sprilicred.test/glm/v1");
		expect(written.providers["sprilicred-deepseek"]).toBeUndefined();
		expect(written.defaultModel).toBe("sprilicred-glm/my-glm");
		expect(cfgCycleModels.get(settings)).toEqual(customCycle);
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

	test("writes the same models.yml as the Sprilicred installer for the same listings", async () => {
		// catalog.json: Sprilicred's live listings (2026-10-12). installer-models.json:
		// deploy/connect.py install_omp (5dff032) on those listings into an empty HOME,
		// default claude-fable-5-1, with every apiKey replaced by "<apiKey>".
		const fixtures = path.join(import.meta.dir, "fixtures", "sprilicred-login-parity");
		const catalog = JSON.parse(await fs.readFile(path.join(fixtures, "catalog.json"), "utf8"));
		const expected = JSON.parse(await fs.readFile(path.join(fixtures, "installer-models.json"), "utf8"));
		globalThis.fetch = (async input => {
			const route = String(input).replace("https://sprilicred.test", "");
			return catalog[route] ? Response.json({ data: catalog[route] }) : new Response("no", { status: 404 });
		}) as typeof fetch;
		await fs.rm(path.join(agentDir, "models.yml"));
		const settings = await Settings.loadIsolated({ agentDir, cwd: root });
		await runSprilicredLogin(noPrompt, settings, "test-key", { home: root, agentDir, tokenPath });
		const written = JSON.parse(await fs.readFile(path.join(agentDir, "models.yml"), "utf8"));
		for (const provider of Object.values(written.providers) as { apiKey: string }[]) provider.apiKey = "<apiKey>";
		expect(Object.keys(written.providers)).toEqual(Object.keys(expected.providers));
		expect(written).toEqual(expected);
	});
});
