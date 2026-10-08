import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { realizesPriorityServiceTier } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// `/fast` on a `sprilicred-anthropic` model must put Claude fast mode on the
// wire in the provider's OAuth (Claude Code) request shape: `speed: "fast"` in
// the body and `fast-mode-2026-02-01` next to `oauth-2025-04-20` in
// `anthropic-beta`. A Claude model the gateway prices fast mode for gets it
// whether models.yml lists it (as `omp login sprilicred` / sprilicred-connect
// write it) or only discovery found it; a model without fast pricing stays a
// standard request.
const FAST_PRICING = { unit: "microcredits_per_token", fast_mode: { speed: "fast", standard_rate_multiplier: 2 } };
const STANDARD_PRICING = { unit: "microcredits_per_token" };
// An agent turn (tools advertised) carries Claude Code's agent beta profile; a
// tool-free call (titles, summaries) carries the utility profile.
const AGENT_CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
	tools: [
		{
			name: "lookup",
			description: "Lookup a value",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	],
};
const UTILITY_CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
};
const REJECTED = '{"type":"error","error":{"type":"invalid_request_error","message":"captured"}}';

type WireRequest = { url: string; beta: string[]; authorization: string | null; body: Record<string, unknown> };

describe("Sprilicred Claude fast mode on the wire", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-sprilicred-fast-"));
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"sprilicred-anthropic": {
						baseUrl: "https://sprilicred.example/anthropic",
						apiKey: "sk-spr-test",
						auth: "oauth",
						authHeader: true,
						api: "anthropic-messages",
						discovery: { type: "openai-models-list" },
						models: [
							{ id: "claude-opus-5-5", name: "claude-opus-5-5 via Sprilicred", compat: { supportsFastMode: true } },
							{ id: "claude-sonnet-5", name: "claude-sonnet-5 via Sprilicred" },
						],
					},
				},
			}),
		);
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	const catalog = async (input: string | URL | Request) => {
		expect(String(input)).toBe("https://sprilicred.example/anthropic/v1/models");
		return Response.json({
			data: [
				{ id: "claude-opus-5-5", context_length: 1_000_000, supports_reasoning: true, pricing: FAST_PRICING },
				{ id: "claude-opus-5", context_length: 1_000_000, supports_reasoning: true, pricing: FAST_PRICING },
				{ id: "claude-sonnet-5", context_length: 1_000_000, supports_reasoning: true, pricing: STANDARD_PRICING },
			],
		});
	};

	async function fastTurn(model: Model<Api>, context: Context = AGENT_CONTEXT): Promise<WireRequest> {
		const requests: WireRequest[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				beta: (headers.get("anthropic-beta") ?? "").split(",").filter(Boolean),
				authorization: headers.get("authorization"),
				body: (await new Response(init?.body).json()) as Record<string, unknown>,
			});
			return new Response(REJECTED, { status: 400, headers: { "Content-Type": "application/json" } });
		};
		await streamSimple(model, context, { apiKey: "sk-spr-test", serviceTier: "priority", fetch: fetchMock }).result();
		const [request] = requests;
		if (!request) throw new Error(`no request sent for ${model.id}`);
		return request;
	}

	test("listed and discovery-only fast models send speed and the fast-mode beta with the OAuth shape", async () => {
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: catalog });
		await registry.refreshProvider("sprilicred-anthropic", "online");

		for (const id of ["claude-opus-5-5", "claude-opus-5"]) {
			const model = registry.find("sprilicred-anthropic", id);
			if (!model) throw new Error(`${id} missing`);
			expect(model.isOAuth).toBe(true);
			expect(realizesPriorityServiceTier("priority", model)).toBe(true);

			const request = await fastTurn(model);
			expect(request.url).toBe("https://sprilicred.example/anthropic/v1/messages");
			expect(request.authorization).toBe("Bearer sk-spr-test");
			expect(request.body.model).toBe(id);
			expect(request.body.speed).toBe("fast");
			expect(request.beta).toContain("fast-mode-2026-02-01");
			expect(request.beta).toContain("oauth-2025-04-20");
			expect(request.beta).toContain("claude-code-20250219");

			const utility = await fastTurn(model, UTILITY_CONTEXT);
			expect(utility.body.model).toBe(id);
			expect(utility.body.speed).toBe("fast");
			expect(utility.beta).toContain("fast-mode-2026-02-01");
			expect(utility.beta).toContain("oauth-2025-04-20");
		}

		const sonnet = registry.find("sprilicred-anthropic", "claude-sonnet-5");
		if (!sonnet) throw new Error("claude-sonnet-5 missing");
		expect(realizesPriorityServiceTier("priority", sonnet)).toBe(false);
		const standard = await fastTurn(sonnet);
		expect(standard.body.model).toBe("claude-sonnet-5");
		expect(standard.body.speed).toBeUndefined();
		expect(standard.beta).not.toContain("fast-mode-2026-02-01");
		expect(standard.beta).toContain("oauth-2025-04-20");
	});

	test("a discovery-only fast model keeps fast mode when loaded from the model cache", async () => {
		const live = new ModelRegistry(authStorage, modelsPath, { fetch: catalog });
		await live.refreshProvider("sprilicred-anthropic", "online");

		const cached = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		const opus5 = cached.find("sprilicred-anthropic", "claude-opus-5");
		if (!opus5) throw new Error("claude-opus-5 missing from the cache");
		expect(realizesPriorityServiceTier("priority", opus5)).toBe(true);
		expect((await fastTurn(opus5)).body.speed).toBe("fast");
	});
});
