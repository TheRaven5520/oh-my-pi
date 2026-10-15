import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// A gateway that describes its models (`supports_reasoning`,
// `max_output_tokens` on each `/models` row, as SpriliCred does) must be able
// to offer a model newer than the bundled catalog that still thinks and writes
// its full output, instead of a non-reasoning 8K/32K default.
describe("openai-models-list discovery honors advertised model capabilities", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-advertised-caps-"));
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	test.each([
		["openai-responses", "https://gateway.example/v1", "gateway-model-next"],
		["anthropic-messages", "https://gateway.example/anthropic", "claude-model-next"],
	] as const)("%s: an uncatalogued reasoning model gets efforts and its output limit", async (api, baseUrl, id) => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl,
						apiKey: "gateway-key",
						authHeader: true,
						api,
						discovery: { type: "openai-models-list", injectV1: api === "anthropic-messages" },
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async () =>
				Response.json({
					data: [
						{ id, context_length: 272000, max_output_tokens: 100000, supports_reasoning: true },
						{ id: `${id}-plain`, context_length: 272000, supports_reasoning: false },
					],
				}),
		});
		await registry.refreshProvider("gateway", "online");

		const reasoning = registry.find("gateway", id);
		expect(reasoning?.reasoning).toBe(true);
		expect(reasoning?.thinking?.efforts).toContain(Effort.High);
		expect(reasoning?.maxTokens).toBe(100000);

		const plain = registry.find("gateway", `${id}-plain`);
		expect(plain?.reasoning).toBe(false);
		expect(plain?.thinking).toBeUndefined();
	});

	test("advertised efforts on a Messages gateway use Claude's adaptive thinking", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "https://gateway.example/anthropic",
						apiKey: "gateway-key",
						authHeader: true,
						api: "anthropic-messages",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		const efforts = ["low", "medium", "high", "xhigh", "max"];
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async () =>
				Response.json({
					data: [{ id: "claude-model-next", supports_reasoning: true, reasoning_efforts: efforts }],
				}),
		});
		await registry.refreshProvider("gateway", "online");
		const model = registry.find("gateway", "claude-model-next");
		expect(model?.thinking?.mode).toBe("anthropic-adaptive");
		expect(model?.thinking?.efforts).toEqual(efforts as Effort[]);
	});

	function writeGateway(api: "anthropic-messages" | "openai-responses"): void {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "https://gateway.example/anthropic",
						apiKey: "gateway-key",
						authHeader: true,
						api,
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
	}

	test("unrecognised advertised efforts such as 'none' are dropped, keeping the known ones", async () => {
		writeGateway("anthropic-messages");
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async () =>
				Response.json({
					data: [
						{ id: "claude-model-next", supports_reasoning: true, reasoning_efforts: ["none", "medium"] },
						{ id: "claude-model-odd", supports_reasoning: true, reasoning_efforts: ["none", "turbo"] },
						{ id: "claude-model-bare", supports_reasoning: true },
					],
				}),
		});
		await registry.refreshProvider("gateway", "online");
		expect(registry.find("gateway", "claude-model-next")?.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Medium],
		});
		// Nothing recognised: treated as if no efforts were advertised.
		expect(registry.find("gateway", "claude-model-odd")?.thinking).toEqual(
			registry.find("gateway", "claude-model-bare")?.thinking,
		);
	});

	test("a catalogued Claude keeps its own thinking mode on a Messages gateway", async () => {
		writeGateway("anthropic-messages");
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async () =>
				Response.json({
					data: [{ id: "claude-sonnet-4-5", supports_reasoning: true, reasoning_efforts: ["low", "high"] }],
				}),
		});
		await registry.refreshProvider("gateway", "online");
		const known = registry.find("gateway", "claude-sonnet-4-5");
		expect(known?.thinking).toEqual({ mode: "budget", efforts: [Effort.Low, Effort.High] });
	});

	test("a catalogued Claude on an OpenAI-wire gateway still takes plain effort", async () => {
		writeGateway("openai-responses");
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async () =>
				Response.json({
					data: [{ id: "claude-sonnet-4-5", supports_reasoning: true, reasoning_efforts: ["low", "high"] }],
				}),
		});
		await registry.refreshProvider("gateway", "online");
		expect(registry.find("gateway", "claude-sonnet-4-5")?.thinking?.mode).toBe("effort");
	});

	// SpriliCred's OpenRouter listing (`/openrouter/v1/models`) names and prices
	// each row itself; the model browser must show those, through a cache restore too.
	test("a gateway's display name, microcredit prices and efforts survive discovery and the cache", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"sprilicred-openrouter": {
						baseUrl: "https://gateway.example/openrouter/v1",
						apiKey: "gateway-key",
						authHeader: true,
						api: "openai-responses",
						discovery: { type: "openai-models-list", injectV1: false },
					},
				},
			}),
		);
		const pricing = (input: unknown, output: unknown, cacheRead: unknown, cacheWrite: unknown) => ({
			unit: "microcredits_per_token",
			usd_per_microcredit: "0.000000001",
			input,
			output,
			cache_read: cacheRead,
			cache_write: cacheWrite,
		});
		const rows = [
			{
				id: "meta/muse-wonder",
				display_name: "Meta: Muse Wonder",
				context_window: 1_048_576,
				context_length: 1_048_576,
				max_output_tokens: 128_000,
				supports_reasoning: true,
				reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
				input_modalities: ["text", "image"],
				pricing: pricing(4000, 20000, 200, null),
			},
			{
				// A bundled identity whose catalog price differs from the gateway's.
				id: "anthropic/claude-fable-5",
				display_name: "Anthropic: Claude Fable 5",
				context_window: 1_000_000,
				max_output_tokens: 128_000,
				supports_reasoning: true,
				reasoning_efforts: ["low", "medium", "high"],
				input_modalities: ["text"],
				pricing: pricing(12000, 60000, 1200, 15000),
			},
			{
				id: "vendor/free-model",
				display_name: "Vendor: Free Model",
				context_window: 131_072,
				supports_reasoning: false,
				reasoning_efforts: null,
				pricing: pricing(0, 0, null, null),
			},
			{
				id: "vendor/unpriced-model",
				display_name: "Vendor: Unpriced Model",
				context_window: 131_072,
				supports_reasoning: false,
				pricing: pricing(null, -1, null, null),
			},
		];
		let listings = 0;
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async input => {
				expect(String(input)).toBe("https://gateway.example/openrouter/v1/models");
				listings++;
				return Response.json({ data: rows });
			},
		});
		await registry.refreshProvider("sprilicred-openrouter", "online");
		expect(listings).toBe(1);
		const restored = new ModelRegistry(authStorage, modelsPath, {
			fetch: async () => Response.json({}, { status: 503 }),
		});

		for (const source of [registry, restored]) {
			const muse = source.find("sprilicred-openrouter", "meta/muse-wonder");
			expect(muse?.name).toBe("Muse Wonder");
			expect(muse?.cost).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 });
			expect(muse?.contextWindow).toBe(1_048_576);
			expect(muse?.maxTokens).toBe(128_000);
			expect(muse?.input).toEqual(["text", "image"]);
			expect(muse?.reasoning).toBe(true);
			expect(muse?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);

			const fable = source.find("sprilicred-openrouter", "anthropic/claude-fable-5");
			expect(fable?.name).toBe("Claude Fable 5");
			expect(fable?.cost).toMatchObject({ input: 12, output: 60, cacheRead: 1.2, cacheWrite: 15 });
			expect(fable?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);

			const free = source.find("sprilicred-openrouter", "vendor/free-model");
			expect(free?.cost).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(free?.pricingStatus).toBe("free");
			expect(getModelPricingStatus(free!)).toBe("free");
			expect(free?.thinking).toBeUndefined();

			const unpriced = source.find("sprilicred-openrouter", "vendor/unpriced-model");
			expect(unpriced?.pricingStatus).toBe("unknown");
			expect(getModelPricingStatus(unpriced!)).toBe("unknown");
		}
	});
});
