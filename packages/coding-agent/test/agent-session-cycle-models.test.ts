import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// Ctrl+P with `cycleModels` cycles whatever the patterns match in the registry
// at the moment of the press: a gateway's discovery adding or withdrawing a
// model changes the cycle without restarting the session or editing config.
describe("AgentSession.cycleModelPatterns", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let listed: string[];
	let fetches: number;
	/** The background list requests presses made, so a test can await them. */
	let refreshes: Promise<void>[];
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-cycle-models-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelsPath = path.join(tempDir, "models.yml");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "https://gateway.example/v1",
						apiKey: "gateway-key",
						authHeader: true,
						api: "openai-responses",
						discovery: { type: "openai-models-list", injectV1: false },
						// Written by an installer run when the gateway still offered it.
						models: [{ id: "retired" }],
					},
					other: {
						baseUrl: "https://other.example/v1",
						apiKey: "other-key",
						api: "openai-responses",
						models: [{ id: "other-model" }],
					},
				},
			}),
		);
		listed = ["alpha", "beta"];
		fetches = 0;
		registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async () => {
				fetches++;
				return Response.json({ data: listed.map(id => ({ id })) });
			},
		});
		await registry.refreshProvider("gateway", "online");
		refreshes = [];
		watchRefreshes(registry);
	});

	/** Record the background list requests presses make on `target`, so tests can await them. */
	function watchRefreshes(target: ModelRegistry): void {
		const refresh = target.refreshDiscoverableProviders.bind(target);
		vi.spyOn(target, "refreshDiscoverableProviders").mockImplementation((ids, strategy) => {
			const pending = refresh(ids, strategy);
			refreshes.push(pending);
			return pending;
		});
	}

	afterEach(async () => {
		await Promise.all(refreshes);
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	function start(modelProvider: string, modelId: string): AgentSession {
		const model = registry.find(modelProvider, modelId);
		if (!model) throw new Error(`missing ${modelProvider}/${modelId}`);
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.High },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		return session;
	}

	test("follows the provider's current listing as models arrive and leave", async () => {
		const active = start("gateway", "alpha");
		const toBeta = await active.cycleModelPatterns(["gateway/*"]);
		expect(toBeta?.model.id).toBe("beta");
		expect(toBeta?.models.map(model => model.id)).toEqual(["alpha", "beta"]);
		expect(active.model?.id).toBe("beta");
		await Promise.all(refreshes);

		listed = ["alpha", "beta", "gamma"];
		await registry.refreshProvider("gateway", "online");
		const toGamma = await active.cycleModelPatterns(["gateway/*"]);
		expect(toGamma?.model.id).toBe("gamma");
		expect(toGamma?.index).toBe(2);

		listed = ["alpha", "gamma"];
		await registry.refreshProvider("gateway", "online");
		const wrapped = await active.cycleModelPatterns(["gateway/*"]);
		expect(wrapped?.models.map(model => model.id)).toEqual(["alpha", "gamma"]);
		expect(wrapped?.model.id).toBe("alpha");
		const back = await active.cycleModelPatterns(["gateway/*"], "backward");
		expect(back?.model.id).toBe("gamma");
	});

	test("enters from a model outside the patterns and applies an explicit level", async () => {
		// A catalog id, so the discovered row knows its thinking efforts.
		listed = ["gpt-5.6-sol", "beta"];
		await registry.refreshProvider("gateway", "online");
		const active = start("other", "other-model");
		const entered = await active.cycleModelPatterns(["gateway/*:low"]);
		expect(entered?.model.id).toBe("gpt-5.6-sol");
		expect(entered?.thinkingLevel).toBe(Effort.Low);
		await active.dispose();

		const fromOutside = start("other", "other-model");
		const last = await fromOutside.cycleModelPatterns(["gateway/*"], "backward");
		expect(last?.model.id).toBe("beta");
	});

	test("reports nothing to cycle when the only match is already active", async () => {
		listed = ["alpha"];
		await registry.refreshProvider("gateway", "online");
		const active = start("gateway", "alpha");
		expect(await active.cycleModelPatterns(["gateway/*"])).toBeUndefined();
		expect(active.model?.id).toBe("alpha");
	});

	test("a press asks the provider for its list, so a newly offered model joins from a later press", async () => {
		const active = start("gateway", "alpha");
		const before = fetches;
		listed = ["alpha", "beta", "gamma"];
		const first = await active.cycleModelPatterns(["gateway/*"]);
		// This press cycles what the registry knew; the list it asked for arrives in the background.
		expect(first?.models.map(model => model.id)).toEqual(["alpha", "beta"]);
		await Promise.all(refreshes);
		expect(fetches).toBe(before + 1);
		const second = await active.cycleModelPatterns(["gateway/*"]);
		expect(second?.models.map(model => model.id)).toEqual(["alpha", "beta", "gamma"]);
		expect(second?.model.id).toBe("gamma");
		// Within the refresh interval, further presses do not ask again.
		await active.cycleModelPatterns(["gateway/*"]);
		await Promise.all(refreshes);
		expect(fetches).toBe(before + 1);
	});

	test("a configured row the provider no longer lists stays out; before any answer, rows stand in", async () => {
		const active = start("gateway", "alpha");
		const listedNow = await active.cycleModelPatterns(["gateway/*"]);
		expect(listedNow?.models.map(model => model.id)).toEqual(["alpha", "beta"]);
		// Still a model the picker can reach by name; only the cycle follows the listing.
		expect(registry.find("gateway", "retired")).toBeDefined();

		const offline = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
			cacheDbPath: path.join(tempDir, "empty-cache.db"),
			fetch: () => Promise.reject(new Error("offline")),
		});
		registry = offline;
		watchRefreshes(offline);
		await active.dispose();
		const unanswered = start("other", "other-model");
		const rows = await unanswered.cycleModelPatterns(["gateway/*"]);
		expect(rows?.models.map(model => model.id)).toEqual(["retired"]);
	});
});
