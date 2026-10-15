import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model } from "@oh-my-pi/pi-ai";
import type { TUI } from "../src/index";
import {
	ModelHubComponent,
	type ModelHubRegistry,
	type ModelHubSearch,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { type ModelSearchHit, ModelSearchSession } from "../src/overlays/model-search-session";
import { initTheme } from "../src/theme";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

function model(provider: string, id: string, name = id): Model {
	return buildModel({
		id,
		name,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 1024,
	});
}

const muse: ModelSearchHit = {
	model: model("sprilicred-openrouter", "meta/muse-wonder", "Muse Wonder via SpriliCred"),
	entry: { id: "meta/muse-wonder" },
};

/** Fire the debounce on the fake clock, then let the search promise and its handlers settle. */
async function flush(): Promise<void> {
	vi.advanceTimersByTime(1);
	for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ModelSearchSession", () => {
	test("debounces, shows loading, then results; empty query returns to idle", async () => {
		const calls: string[] = [];
		let changes = 0;
		const session = new ModelSearchSession(
			"OpenRouter",
			async query => {
				calls.push(query);
				return [muse];
			},
			{ debounceMs: 1, onChange: () => changes++ },
		);
		expect(session.message()).toBe("Type to search OpenRouter");
		session.setQuery("m");
		session.setQuery("mu");
		session.setQuery("muse");
		expect(session.state).toEqual({ status: "loading", query: "muse" });
		expect(session.message()).toBe('Searching OpenRouter for "muse"…');
		await flush();
		expect(calls).toEqual(["muse"]);
		expect(session.hits).toEqual([muse]);
		expect(session.message()).toBeUndefined();
		session.setQuery("  ");
		expect(session.state).toEqual({ status: "idle" });
		expect(changes).toBeGreaterThan(0);
	});

	test("empty and error states are reported inline", async () => {
		const session = new ModelSearchSession(
			"OpenRouter",
			async query => {
				if (query === "boom") throw new Error("HTTP 503 from https://gateway/models");
				return [];
			},
			{ debounceMs: 0, onChange: () => {} },
		);
		session.setQuery("zzz");
		await flush();
		expect(session.message()).toBe('No OpenRouter models match "zzz"');
		session.setQuery("boom");
		await flush();
		expect(session.message()).toBe("Search failed: HTTP 503 from https://gateway/models");
	});

	test("a slow answer for an older query is dropped and its request aborted", async () => {
		const pending = new Map<string, { resolve: (hits: ModelSearchHit[]) => void; signal: AbortSignal }>();
		const session = new ModelSearchSession(
			"OpenRouter",
			(query, signal) => {
				const { promise, resolve } = Promise.withResolvers<ModelSearchHit[]>();
				pending.set(query, { resolve, signal });
				return promise;
			},
			{ debounceMs: 0, onChange: () => {} },
		);
		session.setQuery("mu");
		await flush();
		session.setQuery("muse");
		await flush();
		expect(pending.get("mu")?.signal.aborted).toBe(true);
		pending.get("muse")?.resolve([muse]);
		await flush();
		pending.get("mu")?.resolve([{ model: model("sprilicred-openrouter", "x/stale"), entry: {} }]);
		await flush();
		expect(session.hits).toEqual([muse]);
	});
});

describe("model hub search scope", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	function createSource(): ModelHubSource {
		return {
			revision: 0,
			disabledProviders: [],
			fallbackChains: {},
			modelRoleStorage: "global",
			cycleOrder: [],
			getProjectModelRole: () => undefined,
			getGlobalModelRole: () => undefined,
			getModelRoleSource: () => "default",
			defaultThinkingLevel: "high",
			modelProviderOrder: [],
			knownRoleIds: ["default"],
			mruOrder: [],
			modelPerf: new Map(),
			getModelRole: () => undefined,
			getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
			defaultRoleChain: () => [],
			resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
		};
	}

	function createHub(results: (query: string) => Promise<ModelSearchHit[]>) {
		const registered: Model[] = [];
		const registry: ModelHubRegistry = {
			getError: () => undefined,
			getAvailable: () => registered,
			getAll: () => registered,
			authStorage: { keys: { source: () => undefined } },
			getDiscoverableProviders: () => [],
			getProviderDiscoveryState: () => undefined,
			find: (provider, id) => registered.find(m => m.provider === provider && m.id === id),
			refresh: async () => {},
			refreshProvider: async () => {},
		};
		const picks: ModelSearchHit[] = [];
		const assigned: string[] = [];
		const search: ModelHubSearch = {
			providers: [{ providerId: "sprilicred-openrouter", label: "OpenRouter" }],
			search: (_provider, query) => results(query),
			onPick: async hit => {
				picks.push(hit);
				const stored = model(hit.model.provider, hit.model.id, hit.model.name);
				registered.push(stored);
				return stored;
			},
			debounceMs: 0,
		};
		const hub = new ModelHubComponent(
			tuiStub,
			createSource(),
			registry,
			[{ model: model("work", "fast") }],
			{
				onAssign: (_m, role, _t, selector) => {
					assigned.push(`${role}:${selector}`);
					return true;
				},
				onUnassign: () => {},
				onCancel: () => {},
			},
			{ modelSearch: search },
		);
		const type = (text: string) => {
			for (const char of text) hub.handleInput(char);
		};
		return {
			hub,
			picks,
			registered,
			assigned,
			type,
			body: () => hub.render(140).join("\n").replace(ANSI_PATTERN, ""),
		};
	}

	test("searching lists remote rows; Enter picks through the host and continues with the registered model", async () => {
		const { body, hub, picks, registered, assigned, type } = createHub(async () => [muse]);
		expect(body()).toContain("Search OpenRouter…");
		hub.handleInput("\x1b[B"); // All models → Search OpenRouter…
		expect(body()).toContain("Type to search OpenRouter");
		type("muse");
		await flush();
		expect(body()).toContain("Muse Wonder");
		hub.handleInput("\r");
		await flush();
		expect(picks).toEqual([muse]);
		expect(registered.map(m => m.id)).toEqual(["meta/muse-wonder"]);
		// The role strip opens on the registered model, like activating any configured model.
		hub.handleInput("\r");
		await flush();
		expect(assigned).toEqual(["default:sprilicred-openrouter/meta/muse-wonder"]);
	});

	test("remote hits are not re-filtered locally by the query", async () => {
		const { body, hub, type } = createHub(async () => [muse]);
		hub.handleInput("\x1b[B");
		type("wonderful muse");
		await flush();
		expect(body()).toContain("Muse Wonder");
	});

	test("empty and error states render inline", async () => {
		const { body, hub, type } = createHub(async query => {
			if (query === "bad") throw new Error("HTTP 403 from https://gateway/models");
			return [];
		});
		hub.handleInput("\x1b[B");
		type("zzz");
		await flush();
		expect(body()).toContain('No OpenRouter models match "zzz"');
		for (let i = 0; i < 3; i++) hub.handleInput("\x7f");
		type("bad");
		await flush();
		expect(body()).toContain("Search failed: HTTP 403");
	});

	test("leaving the remote search scope recounts local matches for the current query", async () => {
		const { body, hub, type } = createHub(async () => [muse]);
		const allModelsCount = () => body().match(/All models\s+(\d+)/)?.[1];
		type("fast");
		expect(allModelsCount()).toBe("1");
		hub.handleInput("\x1b[D"); // focus the sidebar (typing focused the list)
		hub.handleInput("\x1b[B"); // All models → Search OpenRouter…
		for (let i = 0; i < 4; i++) hub.handleInput("\x7f");
		type("muse");
		await flush();
		expect(body()).toContain("type to search; Enter adds");
		hub.handleInput("\x1b[D");
		hub.handleInput("\x1b[A"); // back to All models, query still "muse"
		expect(allModelsCount()).toBe("0");
	});
});
