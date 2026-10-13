import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { createModelHubSearch } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// Providers with `modelSearch` (Sprilicred's OpenRouter catalog) are searched
// from /model instead of discovered: the search hits `<baseUrl>/models?search=`,
// a pick is written into models.yml once, and it never joins Ctrl+P.

const GATEWAY_KEY = "sk-test-gateway-0000";
const MUSE_ROW = {
	id: "meta/muse-wonder",
	display_name: "Muse Wonder",
	context_window: 1_048_576,
	max_output_tokens: 65_536,
	supports_reasoning: true,
	reasoning_efforts: ["none", "low", "high"],
	input_modalities: ["text", "image"],
	pricing: {
		unit: "microcredits_per_token",
		usd_per_microcredit: 1e-9,
		input: 1250,
		output: 10000,
		cache_read: 125,
		cache_write: 0,
	},
};
const MUSE_ENTRY = {
	id: "meta/muse-wonder",
	name: "Muse Wonder via Sprilicred",
	contextWindow: 1_048_576,
	maxTokens: 65_536,
	reasoning: true,
	thinking: { mode: "effort", efforts: ["low", "high"] },
	input: ["text", "image"],
	cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

function openRouterProvider(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		baseUrl: "https://gateway.example/openrouter/v1",
		apiKey: GATEWAY_KEY,
		authHeader: true,
		api: "openai-responses",
		modelSearch: { type: "openai-models-list", param: "search", limit: 25 },
		...extra,
	};
}

describe("models.yml modelSearch schema", () => {
	const config = (provider: Record<string, unknown>) => ({ providers: { p: provider } });
	const validate = (provider: Record<string, unknown>) => ModelsConfigSchema(config(provider));

	test("accepts openai-models-list with a param and a positive integer limit", () => {
		expect(ModelsConfigSchema.allows(config(openRouterProvider()))).toBe(true);
	});

	test("rejects unknown types, empty params and bad limits with a clear message", () => {
		const unknown = validate(openRouterProvider({ modelSearch: { type: "litellm", param: "search", limit: 25 } }));
		expect(String(unknown)).toContain('a supported modelSearch type ("openai-models-list")');
		const noParam = validate(
			openRouterProvider({ modelSearch: { type: "openai-models-list", param: " ", limit: 25 } }),
		);
		expect(String(noParam)).toContain("modelSearch.param a non-empty string");
		for (const limit of [0, -1, 2.5]) {
			const bad = validate(
				openRouterProvider({ modelSearch: { type: "openai-models-list", param: "search", limit } }),
			);
			expect(String(bad)).toContain("modelSearch.limit a positive integer");
		}
		expect(
			ModelsConfigSchema.allows(
				config(openRouterProvider({ modelSearch: { type: "openai-models-list", param: "search" } })),
			),
		).toBe(false);
		expect(
			ModelsConfigSchema.allows(
				config(openRouterProvider({ modelSearch: { type: "litellm", param: "q", limit: 5 } })),
			),
		).toBe(false);
	});

	test("a modelSearch provider needs api and baseUrl", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-model-search-schema-"));
		try {
			const file = path.join(dir, "models.yml");
			const { api: _api, ...noApi } = openRouterProvider();
			fs.writeFileSync(file, JSON.stringify({ providers: { "sprilicred-openrouter": noApi } }));
			const result = ModelsConfigFile.relocate(file).tryLoad();
			expect(result.status).toBe("error");
			expect(String(result.error)).toContain('"baseUrl" and "api" are required when modelSearch is enabled');
		} finally {
			removeSyncWithRetries(dir);
		}
	});
});

describe("ModelRegistry model search", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelsPath: string;
	let requests: { url: string; authorization: string | null }[];
	let respond: (url: URL) => Response | Promise<Response>;

	function makeRegistry(): ModelRegistry {
		return new ModelRegistry(authStorage, modelsPath, {
			fetch: async (input, init) => {
				const url = new URL(String(input));
				requests.push({ url: url.toString(), authorization: new Headers(init?.headers).get("authorization") });
				return respond(url);
			},
		});
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-model-search-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelsPath = path.join(tempDir, "models.yml");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { "sprilicred-openrouter": openRouterProvider() } }, null, 2),
		);
		requests = [];
		respond = () => Response.json({ object: "list", data: [MUSE_ROW] });
	});

	afterEach(() => {
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	test("offers search for a provider with modelSearch but no models yet", () => {
		const registry = makeRegistry();
		expect(registry.getModelSearchProviders()).toEqual(["sprilicred-openrouter"]);
		expect(registry.find("sprilicred-openrouter", "meta/muse-wonder")).toBeUndefined();
	});

	test("queries <baseUrl>/models?<param>=<q>&limit=<limit> with the provider's key", async () => {
		const registry = makeRegistry();
		await registry.searchModels("sprilicred-openrouter", "muse wonder");
		expect(requests).toEqual([
			{
				url: "https://gateway.example/openrouter/v1/models?search=muse+wonder&limit=25",
				authorization: `Bearer ${GATEWAY_KEY}`,
			},
		]);
	});

	test("parses rows like discovery: name, context, output, efforts, input and $/MTok", async () => {
		const [hit, ...rest] = await makeRegistry().searchModels("sprilicred-openrouter", "muse");
		expect(rest).toEqual([]);
		expect(hit.model).toMatchObject({
			provider: "sprilicred-openrouter",
			id: "meta/muse-wonder",
			name: "Muse Wonder via Sprilicred",
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		});
		expect(hit.model.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
		expect(hit.entry).toEqual(MUSE_ENTRY);
		expect(Object.keys(hit.entry)).toEqual([
			"id",
			"name",
			"contextWindow",
			"maxTokens",
			"reasoning",
			"thinking",
			"input",
			"cost",
		]);
	});

	test("efforts ['none','low','high'] give ['low','high']; no thinking when the row does not reason", async () => {
		respond = () =>
			Response.json({
				data: [
					{ id: "a/reasons", supports_reasoning: true, reasoning_efforts: ["none", "low", "high"] },
					{ id: "b/plain", supports_reasoning: false, reasoning_efforts: ["low"] },
					{ id: "c/silent" },
				],
			});
		const hits = await makeRegistry().searchModels("sprilicred-openrouter", "x");
		expect(hits.map(hit => hit.entry)).toEqual([
			{
				id: "a/reasons",
				name: "a/reasons via Sprilicred",
				reasoning: true,
				thinking: { mode: "effort", efforts: ["low", "high"] },
			},
			{ id: "b/plain", name: "b/plain via Sprilicred", reasoning: false },
			{ id: "c/silent", name: "c/silent via Sprilicred" },
		]);
	});

	test("bad rows and non-chat rows are skipped, not fatal", async () => {
		respond = () =>
			Response.json({
				data: [
					null,
					7,
					{ id: 42 },
					{ display_name: "no id" },
					{ id: "x/embed", output_modalities: ["embeddings"] },
					{ id: "x/ok", context_window: "oops", pricing: { unit: "microcredits_per_token", input: "bad" } },
				],
			});
		const hits = await makeRegistry().searchModels("sprilicred-openrouter", "x");
		expect(hits.map(hit => hit.model.id)).toEqual(["x/ok"]);
		expect(hits[0].entry).toEqual({ id: "x/ok", name: "x/ok via Sprilicred" });
		respond = () => Response.json({ data: "not a list" });
		expect(await makeRegistry().searchModels("sprilicred-openrouter", "x")).toEqual([]);
	});

	test("an HTTP error surfaces as an error", async () => {
		respond = () => new Response("nope", { status: 503 });
		await expect(makeRegistry().searchModels("sprilicred-openrouter", "muse")).rejects.toThrow("503");
	});

	test("a pick appends the entry once, keeps JSON, never writes the key, and loads without restart", async () => {
		const registry = makeRegistry();
		const [hit] = await registry.searchModels("sprilicred-openrouter", "muse");
		const added = await registry.addSearchedModel(hit);
		expect(added).toMatchObject({
			provider: "sprilicred-openrouter",
			id: "meta/muse-wonder",
			name: "Muse Wonder via Sprilicred",
		});
		expect(
			registry
				.getAvailable()
				.some(model => model.provider === "sprilicred-openrouter" && model.id === "meta/muse-wonder"),
		).toBe(true);
		await registry.addSearchedModel(hit);
		const raw = fs.readFileSync(modelsPath, "utf-8");
		expect(raw.trimStart().startsWith("{")).toBe(true);
		const written = JSON.parse(raw);
		expect(written.providers["sprilicred-openrouter"].models).toEqual([MUSE_ENTRY]);
		expect(Object.keys(written.providers["sprilicred-openrouter"].models[0])).toEqual([
			"id",
			"name",
			"contextWindow",
			"maxTokens",
			"reasoning",
			"thinking",
			"input",
			"cost",
		]);
		expect(written.providers["sprilicred-openrouter"].apiKey).toBe(GATEWAY_KEY);
		expect(raw.split(GATEWAY_KEY).length - 1).toBe(1);
		expect(raw).not.toContain("Authorization");
		expect(raw).not.toContain("headers");
	});

	test("a YAML models.yml stays YAML and keeps entries written since the registry loaded", async () => {
		fs.writeFileSync(
			modelsPath,
			`providers:\n  sprilicred-openrouter:\n    baseUrl: https://gateway.example/openrouter/v1\n    apiKey: ${GATEWAY_KEY}\n    api: openai-responses\n    modelSearch:\n      type: openai-models-list\n      param: search\n      limit: 25\n`,
		);
		const registry = makeRegistry();
		const [hit] = await registry.searchModels("sprilicred-openrouter", "muse");
		// The installer rewrites the file after this session loaded it.
		fs.appendFileSync(
			modelsPath,
			"  other:\n    baseUrl: https://other.example/v1\n    apiKey: k\n    api: openai-responses\n    models:\n      - id: o\n",
		);
		await registry.addSearchedModel(hit);
		const raw = fs.readFileSync(modelsPath, "utf-8");
		expect(raw.trimStart().startsWith("{")).toBe(false);
		const written = Bun.YAML.parse(raw) as { providers: Record<string, { models?: unknown[] }> };
		expect(written.providers["sprilicred-openrouter"].models).toEqual([MUSE_ENTRY]);
		expect(written.providers.other.models).toEqual([{ id: "o" }]);
	});
});

// The installer scopes enabledModels to include `sprilicred-openrouter/**`;
// a picked model joins that scope (so /model lists it) and never the Ctrl+P cycle.
describe("a picked search model and Ctrl+P", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		initTheme();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-model-search-ctrl-p-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		resetSettingsForTest();
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	for (const cycleModels of [[], ["work/*"]]) {
		test(`stays out of Ctrl+P (cycleModels ${JSON.stringify(cycleModels)}) while listed in the /model scope`, async () => {
			const overrides = {
				enabledModels: ["work/*", "sprilicred-openrouter/**"],
				cycleModels,
				modelRoles: { default: "work/fast", smol: "work/small" },
				cycleOrder: ["default", "smol"],
			};
			await Settings.init({ inMemory: true, overrides });
			const modelsPath = path.join(tempDir, "models.yml");
			fs.writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						work: {
							baseUrl: "https://work.example/v1",
							apiKey: "work-key",
							api: "openai-responses",
							models: [{ id: "fast" }, { id: "small" }],
						},
						"sprilicred-openrouter": openRouterProvider(),
					},
				}),
			);
			const registry = new ModelRegistry(authStorage, modelsPath, {
				fetch: async () => Response.json({ data: [MUSE_ROW] }),
			});
			const fast = registry.find("work", "fast");
			const small = registry.find("work", "small");
			if (!fast || !small) throw new Error("missing work models");
			const active = new AgentSession({
				agent: new Agent({
					initialState: {
						model: fast,
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
						thinkingLevel: Effort.High,
					},
				}),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(overrides),
				modelRegistry: registry,
			});
			session = active;
			active.setScopedModels([{ model: fast }, { model: small }]);

			const search = createModelHubSearch(registry, active, {
				showStatus: () => {},
				showError: message => {
					throw new Error(message);
				},
			});
			if (!search) throw new Error("no search offered");
			expect(search.providers).toEqual([{ providerId: "sprilicred-openrouter", label: "Sprilicred Openrouter" }]);
			const [hit] = await search.search("sprilicred-openrouter", "muse", new AbortController().signal);
			const picked = await search.onPick(hit);
			expect(picked?.id).toBe("meta/muse-wonder");
			expect(active.scopedModels.map(scoped => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
				"work/fast",
				"work/small",
				"sprilicred-openrouter/meta/muse-wonder",
			]);

			const visited: string[] = [];
			const ctx = {
				session: active,
				viewSession: active,
				statusLine: { invalidate: () => {} },
				updateEditorBorderColor: () => {},
				showModelCycleTrack: () => {},
				showStatus: () => {},
				showError: (message: string) => {
					throw new Error(message);
				},
			} as unknown as InteractiveModeContext;
			const controller = new InputController(ctx);
			for (let press = 0; press < 4; press++) {
				await controller.cycleRoleModel();
				visited.push(`${active.model?.provider}/${active.model?.id}`);
			}
			expect(visited).toEqual(["work/small", "work/fast", "work/small", "work/fast"]);
		});
	}
});
