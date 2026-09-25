import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// A gateway that describes its models (`supports_reasoning`,
// `max_output_tokens` on each `/models` row, as Sprilicred does) must be able
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
});
