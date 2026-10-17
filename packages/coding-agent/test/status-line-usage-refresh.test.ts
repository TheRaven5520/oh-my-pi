import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CodexResetFireworksEvent } from "@oh-my-pi/pi-tui/overlays/codex-reset-fireworks";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

import { cfgTuiCodexResetFireworks } from "@oh-my-pi/pi-coding-agent/modes/settings";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function makeSession(fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>): AgentSession {
	const messages: unknown[] = [];
	return {
		fetchUsageReports,
		messages,
		state: { messages, model: { contextWindow: 200_000 } },
		model: { contextWindow: 200_000 },
		isStreaming: false,
		isFastModeActive: () => false,
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

function usageReport(percent: number): unknown[] {
	return [
		{
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5h", resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: percent / 100 },
				},
			],
		},
	];
}

interface CodexUsageState {
	sevenDayPercent: number;
	sevenDayResetAt: number;
	savedResets?: number;
	omitFetchedAt?: boolean;
	tier?: string;
	plan?: string;
}

function codexUsageReport(
	state: CodexUsageState,
	accountId = "account-1",
	email = "codex@example.com",
	orgId?: string,
): unknown[] {
	return [
		{
			provider: "openai-codex",
			...(state.omitFetchedAt ? {} : { fetchedAt: Date.now() }),
			metadata: {
				accountId,
				email,
				...(orgId ? { orgId } : {}),
				...(state.plan ? { planType: state.plan } : {}),
			},
			...(state.savedResets === undefined ? {} : { resetCredits: { availableCount: state.savedResets } }),
			limits: [
				{
					id: "openai-codex:secondary",
					label: "Codex 7 Day",
					scope: {
						provider: "openai-codex",
						accountId,
						windowId: "7d",
						...(state.tier ? { tier: state.tier } : {}),
					},
					window: {
						id: "7d",
						label: "7d",
						resetsAt: state.sevenDayResetAt,
					},
					amount: { unit: "percent", usedFraction: state.sevenDayPercent / 100 },
				},
			],
		},
	];
}

function makeCodexSession(
	fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>,
	resolveActiveIdentity: () => { accountId: string; email?: string; orgId?: string } = () => ({
		accountId: "account-1",
		email: "codex@example.com",
	}),
): AgentSession {
	const session = makeSession(fetchUsageReports) as unknown as Record<string, unknown>;
	session.sessionId = "session-1";
	session.state = {
		messages: [],
		model: { contextWindow: 200_000, provider: "openai-codex" },
	};
	session.model = { contextWindow: 200_000, provider: "openai-codex" };
	session.modelRegistry = {
		isUsingOAuth: () => true,
		authStorage: {
			oauth: { identity: resolveActiveIdentity },
		},
	};
	return session as unknown as AgentSession;
}

async function refreshUsage(component: StatusLineComponent, advanceMs = 0): Promise<void> {
	if (advanceMs > 0) vi.advanceTimersByTime(advanceMs);
	component.refreshUsageInBackground();
	vi.advanceTimersByTime(0);
	await flushMicrotasks();
}

function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("StatusLineComponent usage refresh", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("renders both Central pools and all tiers without refetching or exposing account metadata", async () => {
		const report = (provider: string, account: string, fraction: number, tier?: string) => ({
			provider,
			fetchedAt: Date.now(),
			metadata: { sprilicredAccountId: account, token: "secret-token" },
			limits: [
				{
					id: `${provider}:secondary`,
					label: "private-label",
					scope: { windowId: "7d", tier },
					window: { label: "7d" },
					amount: { unit: "percent", usedFraction: fraction },
				},
			],
		});
		const codex = report("openai-codex", "private-codex", 0.25);
		const fetch = vi.fn(async () => [
			codex,
			codex,
			report("openai-codex", "private-second-codex", 0.75),
			report("openai-codex", "private-ultrafast", 0.5, "ultrafast"),
			report("anthropic", "private-claude", 0.125),
			report("anthropic", "private-fable", 0.375, "fable"),
		]);
		const component = new StatusLineComponent(makeSession(fetch), statusLineHost);
		try {
			component.updateSettings({ preset: "custom", leftSegments: ["session_name"], rightSegments: [] });
			await refreshUsage(component);
			const workspace = component.renderCentralWorkspace(120, 40);
			const rows = workspace.usageLines.map(plain);
			expect(rows).toContain("Codex pool");
			expect(rows).toContain("Claude pool");
			expect(rows).toContain("wk 50%");
			expect(rows).toContain("ultrafast wk 50%");
			expect(rows).toContain("wk 87%");
			expect(rows).toContain("fable wk 62%");
			expect(plain(workspace.statusLines.join(""))).toContain("test");
			expect(workspace.usageLines.join("")).toContain("\x1b[38;5;211m");
			expect(rows.join("\n")).not.toMatch(/private|secret|\|/);
			component.renderCentralWorkspace(120, 40);
			vi.advanceTimersByTime(0);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			component.dispose();
		}
	});

	it("renders the supplied main session without retargeting the focused child", async () => {
		const mainFetch = vi.fn(async () => usageReport(20));
		const main = makeSession(mainFetch);
		const child = makeSession(async () => usageReport(80));
		Object.assign(main.sessionManager, { getSessionName: () => "source-main" });
		Object.assign(child.sessionManager, { getSessionName: () => "focused-child" });
		Object.assign(main, { getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }) });
		Object.assign(child, { getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000, percent: 50 }) });
		const component = new StatusLineComponent(main, statusLineHost);
		try {
			component.updateSettings({
				preset: "custom",
				leftSegments: ["session_name", "context_pct"],
				rightSegments: [],
			});
			component.setSession(child, "child-id");
			await refreshUsage(component);
			component.renderCentralWorkspace(120, 40, main);
			vi.advanceTimersByTime(0);
			await flushMicrotasks();
			const source = component.renderCentralWorkspace(120, 40, main);
			const focused = component.renderCentralWorkspace(120, 40);
			expect(plain(source.statusLines.join(" "))).toContain("source-main");
			expect(plain(source.statusLines.join(" "))).toMatch(/\b25(?:\.0)?%/);
			expect(source.usageLines.map(plain).join(" ")).toContain("5h 80%");
			expect(plain(focused.statusLines.join(" "))).toContain("focused-child");
			expect(plain(focused.statusLines.join(" "))).toMatch(/\b50(?:\.0)?%/);
			expect(focused.usageLines.map(plain).join(" ")).toContain("5h 20%");
			expect(mainFetch).toHaveBeenCalledTimes(1);
		} finally {
			component.dispose();
		}
	});

	it("disposes the dedicated source renderer with its owner", async () => {
		const fetch = vi.fn(async () => usageReport(20));
		const source = makeSession(fetch);
		const component = new StatusLineComponent(
			makeSession(async () => []),
			statusLineHost,
		);
		component.renderCentralWorkspace(120, 40, source);
		component.dispose();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("names real provider windows and derives the Fable meter without a tier field", async () => {
		const reports = [
			{
				provider: "anthropic",
				fetchedAt: Date.now(),
				metadata: { sprilicredAccountId: "claude-source-account" },
				limits: [
					{
						id: "claude-short",
						scope: { windowId: "5h" },
						window: { label: "5-hour" },
						amount: { usedFraction: 0.03125 },
					},
					{
						id: "claude-long",
						scope: { windowId: "7d" },
						window: { label: "Weekly total" },
						amount: { usedFraction: 0.8125 },
					},
					{
						id: "claude-model",
						scope: { windowId: "7d:fable" },
						window: { label: "Fable weekly" },
						amount: { usedFraction: 0.65625 },
					},
				],
			},
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				metadata: { sprilicredAccountId: "codex-source-account" },
				limits: [
					{
						id: "openai-codex:secondary",
						scope: { windowId: "chat:secondary" },
						window: { label: "Weekly" },
						amount: { usedFraction: 0.25 },
					},
					{
						id: "openai-codex:secondary",
						scope: { windowId: "chat:secondary", tier: "ultrafast" },
						window: { label: "Weekly" },
						amount: { usedFraction: 0.5 },
					},
				],
			},
		];
		const component = new StatusLineComponent(
			makeSession(async () => reports),
			statusLineHost,
		);
		try {
			await refreshUsage(component);
			const workspace = component.renderCentralWorkspace(120, 40);
			expect(workspace.usageLines.map(plain)).toEqual([
				"Codex pool",
				"wk 75%",
				"ultrafast wk 50%",
				"Claude pool",
				"5h 96%",
				"wk 18%",
				"fable wk 34%",
			]);
			expect(workspace.usageLines.join(" ")).toContain("\x1b[38;5;176m5h");
			expect(workspace.usageLines.join(" ")).toContain("\x1b[38;5;217mfable wk");
			expect(reports[0]!.limits[2]!.scope).toEqual({ windowId: "7d:fable" });
		} finally {
			component.dispose();
		}
	});

	it("keeps Central account credits scoped and marks failed refreshes stale", async () => {
		const fetch = vi.fn(async () =>
			codexUsageReport({ sevenDayPercent: 20, sevenDayResetAt: Date.now() + 60_000, savedResets: 2 }),
		);
		const component = new StatusLineComponent(makeCodexSession(fetch), statusLineHost);
		try {
			await refreshUsage(component);
			const rows = component.renderCentralWorkspace(120, 40).usageLines.map(plain);
			expect(rows).toContain("resets 2");
			expect(rows).toContain("usable 2");
			expect(rows).toContain("Claude unavailable");
			fetch.mockRejectedValueOnce(new Error("secret backend error"));
			await refreshUsage(component, 300_000);
			const stale = component.renderCentralWorkspace(120, 40).usageLines.map(plain);
			expect(stale).toContain("Codex stale");
			expect(stale.join(" ")).not.toContain("secret");
		} finally {
			component.dispose();
		}
	});

	it("invalidates the inactive provider account without mixing subscriptions", async () => {
		let accountId = "account-1";
		const reports = [
			...codexUsageReport({ sevenDayPercent: 20, sevenDayResetAt: 0 }, "account-1", "first@example.com"),
			...codexUsageReport({ sevenDayPercent: 70, sevenDayResetAt: 0 }, "account-2", "second@example.com"),
		];
		const session = makeCodexSession(
			async () => reports,
			() => ({ accountId }),
		);
		const model = { contextWindow: 200_000, provider: "anthropic" };
		Object.assign(session, { model, state: { messages: [], model } });
		const component = new StatusLineComponent(session, statusLineHost);
		try {
			await refreshUsage(component);
			expect(component.renderCentralWorkspace(120, 40).usageLines.map(plain).join(" ")).toContain("wk 80%");
			accountId = "account-2";
			expect(component.renderCentralWorkspace(120, 40).usageLines.map(plain)).toContain("Codex unavailable");
			await refreshUsage(component);
			expect(component.renderCentralWorkspace(120, 40).usageLines.map(plain).join(" ")).toContain("wk 30%");
		} finally {
			component.dispose();
		}
	});

	it("shows only the active route's pool, never a Claude model's unrelated subscription", async () => {
		const reports = [
			{
				provider: "anthropic",
				metadata: { sprilicredAccountId: "claude-pool" },
				limits: [
					{ id: "5h", scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } },
					{ id: "7d", scope: { windowId: "7d" }, amount: { usedFraction: 0.28 } },
				],
			},
			{
				provider: "openai-codex",
				metadata: { sprilicredAccountId: "codex-pool" },
				limits: [{ id: "7d", scope: { windowId: "7d" }, amount: { usedFraction: 0.61 } }],
			},
		];
		for (const [provider, providerType, identityClass, quota] of [
			["sprilicred-anthropic", undefined, "anthropic", "28%"],
			["anthropic", undefined, "anthropic", "28%"],
			["sprilicred-openai", undefined, "openai", "61%"],
			["openai-codex", undefined, "openai", "61%"],
			["openrouter", undefined, "anthropic", undefined],
			["sprilicred-openrouter", undefined, "anthropic", undefined],
			["openai", undefined, "openai", undefined],
			["sprilicred-anthropic", "openrouter", "anthropic", undefined],
			["sprilicred-openai", undefined, "glm", undefined],
			["sprilicred-openai", undefined, "deepseek", undefined],
			["sprilicred-openai", undefined, "unknown", undefined],
			["sprilicred-openai", undefined, "anthropic", undefined],
			[undefined, undefined, "anthropic", undefined],
		]) {
			const session = makeSession(async () => reports);
			// The same Anthropic wire API does not establish quota applicability.
			// Legacy proxy rows must also match the subscription's model lineage.
			const model = {
				id: identityClass === "openai" ? "gpt-6-astra" : "claude-opus-5-5",
				provider,
				providerType,
				api: "anthropic-messages",
				identity: { class: identityClass },
				contextWindow: 200_000,
			};
			Object.assign(session, { model, state: { messages: [], model } });
			const component = new StatusLineComponent(session, statusLineHost);
			try {
				component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"] });
				await refreshUsage(component);
				const content = plain(component.getTopBorder(200).content);
				if (quota) expect(content).toContain(quota);
				else {
					expect(content).not.toMatch(/5h|7d|28%|61%/);
					component.updateSettings({ preset: "claude" });
					expect(plain(component.getTopBorder(200).content)).not.toMatch(/\b5h\b|\bwk\b|\bfable\b/);
				}
			} finally {
				component.dispose();
			}
		}
	});

	it("drops cached pooled totals when only the discovery route changes", async () => {
		const reports = [
			{
				provider: "anthropic",
				metadata: { sprilicredAccountId: "pool" },
				limits: [{ id: "7d", scope: { windowId: "7d" }, amount: { usedFraction: 0.28 } }],
			},
		];
		const session = makeSession(async () => reports);
		const model = {
			id: "claude-opus-5-5",
			provider: "sprilicred-anthropic",
			providerType: "anthropic",
			contextWindow: 200_000,
		};
		Object.assign(session, { model, state: { messages: [], model } });
		const component = new StatusLineComponent(session, statusLineHost);
		try {
			component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"] });
			await refreshUsage(component);
			expect(plain(component.getTopBorder(200).content)).toContain("28%");
			model.providerType = "openrouter";
			component.refreshUsageInBackground();
			expect(plain(component.getTopBorder(200).content)).not.toContain("28%");
			await refreshUsage(component);
			expect(plain(component.getTopBorder(200).content)).not.toContain("28%");
			model.providerType = "anthropic";
			await refreshUsage(component);
			expect(plain(component.getTopBorder(200).content)).toContain("28%");
			// Mutating a discovery source must also miss the render memo without
			// an explicit refresh or a replacement model object.
			expect(JSON.stringify(component.describeComposerFacts())).toContain("28%");
			model.providerType = "openrouter";
			expect(JSON.stringify(component.describeComposerFacts())).not.toContain("28%");
			expect(plain(component.getTopBorder(200).content)).not.toContain("28%");
		} finally {
			component.dispose();
		}
	});

	it.each(["endpoint", "lineage"])("invalidates quota renders when only %s changes", async change => {
		const reports = [
			{
				provider: "openai-codex",
				metadata: { sprilicredAccountId: "pool" },
				limits: [{ id: "7d", scope: { windowId: "7d" }, amount: { usedFraction: 0.61 } }],
			},
		];
		const session = makeSession(async () => reports);
		const model = {
			id: "gpt-6-astra",
			provider: "sprilicred-openai",
			identity: { class: "openai" },
			baseUrl: "https://gateway.example/v1",
			contextWindow: 200_000,
		};
		Object.assign(session, { model, state: { messages: [], model } });
		const component = new StatusLineComponent(session, statusLineHost);
		try {
			component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: ["usage"] });
			await refreshUsage(component);
			expect(plain(component.getTopBorder(200).content)).toContain("61%");
			if (change === "endpoint") model.baseUrl = "https://gateway.example/openrouter/v1";
			else model.identity.class = "deepseek";
			expect(plain(component.getTopBorder(200).content)).not.toContain("61%");
			await refreshUsage(component);
			expect(plain(component.getTopBorder(200).content)).not.toContain("61%");
		} finally {
			component.dispose();
		}
	});

	it("does not let an old route's in-flight response populate or delay the new route", async () => {
		const pending = Promise.withResolvers<unknown>();
		let calls = 0;
		const session = makeSession(() => (++calls === 1 ? pending.promise : Promise.resolve([])));
		const model = {
			id: "claude-opus-5-5",
			provider: "sprilicred-anthropic",
			providerType: "anthropic",
			contextWindow: 200_000,
		};
		Object.assign(session, { model, state: { messages: [], model } });
		const component = new StatusLineComponent(session, statusLineHost);
		try {
			component.updateSettings({ preset: "claude" });
			await refreshUsage(component);
			model.providerType = "openrouter";
			component.refreshUsageInBackground();
			pending.resolve([
				{
					provider: "anthropic",
					metadata: { sprilicredAccountId: "pool" },
					limits: [{ id: "7d", scope: { windowId: "7d" }, amount: { usedFraction: 0.28 } }],
				},
			]);
			await flushMicrotasks();
			await refreshUsage(component);
			expect(calls).toBe(2);
			expect(plain(component.getTopBorder(200).content)).not.toMatch(/\b5h\b|\bwk\b|\bfable\b/);
		} finally {
			component.dispose();
		}
	});

	it("does not invoke usage fetching synchronously on the render path", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(async () => {
				calls++;
				return [];
			}),
			statusLineHost,
		);

		component.refreshUsageInBackground();
		expect(calls).toBe(0);

		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("passes a startup timeout signal to the background usage fetch", async () => {
		let signal: AbortSignal | undefined;
		const component = new StatusLineComponent(
			makeSession(async nextSignal => {
				signal = nextSignal;
				return [];
			}),
			statusLineHost,
		);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("backs off after the startup timeout when usage fetching hangs", async () => {
		let calls = 0;
		const component = new StatusLineComponent(
			makeSession(() => {
				calls++;
				return Promise.withResolvers<unknown>().promise;
			}),
			statusLineHost,
		);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		component.refreshUsageInBackground();
		expect(calls).toBe(1);

		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();

		expect(calls).toBe(1);
	});

	it("applies late usage reports that resolve after the startup timeout", async () => {
		const late = Promise.withResolvers<unknown>();
		const component = new StatusLineComponent(
			makeSession(() => late.promise),
			statusLineHost,
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();

		expect(plain(component.getTopBorder(80).content)).not.toContain("5h");

		late.resolve(usageReport(42));
		await flushMicrotasks();

		expect(plain(component.getTopBorder(80).content)).toContain("5h 42%");
	});

	it("shows Claude's banked count, current availability, and expiry in the usage segment", async () => {
		const expiresAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
		const reports = usageReport(25) as Array<Record<string, unknown>>;
		reports[0]!.resetCredits = {
			availableCount: 3,
			redeemableCount: 0,
			reason: "weekly cooldown",
			credits: [
				{
					id: "cedar",
					title: "Claude reset",
					program: "cedar_ember",
					remainingCount: 3,
					usable: false,
					requiresLimit: true,
					clears: ["anthropic:5h", "anthropic:7d"],
					blocking: [],
					usedFractions: {},
					expiresAt,
				},
			],
		};
		const component = new StatusLineComponent(
			makeSession(async () => reports),
			statusLineHost,
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["usage"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		await refreshUsage(component);

		const output = plain(component.getTopBorder(120).content);
		expect(output).toContain("✦ 3 (0 usable)");
		expect(output).toContain("exp 2d");
		expect(output).toContain("weekly cooldown");
	});

	it("re-fetches usage immediately when the session rotates to another org under the same email", async () => {
		let calls = 0;
		let orgId = "org-team";
		const base = makeSession(async () => {
			calls++;
			return usageReport(10);
		}) as unknown as Record<string, unknown>;
		// Same provider + email + account throughout — only the org rotates.
		base.state = {
			messages: [],
			model: { contextWindow: 200_000, provider: "anthropic" },
		};
		base.modelRegistry = {
			authStorage: {
				oauth: {
					identity: () => ({
						email: "shared@example.com",
						accountId: "account-shared",
						orgId,
					}),
				},
			},
		};
		const component = new StatusLineComponent(base as unknown as AgentSession, statusLineHost);

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Same org within the cache TTL: served from cache, no refetch.
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(1);

		// Org rotation under the same email/account must invalidate the cache.
		orgId = "org-max";
		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		expect(calls).toBe(2);
	});

	it("keeps reset fireworks opt-in while advancing the disabled baseline", async () => {
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		expect(cfgTuiCodexResetFireworks.get(Settings.instance)).toBe(false);
		await refreshUsage(component);
		state = {
			sevenDayPercent: 0,
			sevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, 5 * 60_000);
		expect(events).toEqual([]);
		component.dispose();
	});

	it("emits distinct enabled events for an unscheduled weekly reset and a newly banked reset", async () => {
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		const nextSevenDayResetAt = sevenDayResetAt + 7 * 24 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		expect(events).toEqual([]);
		state = {
			sevenDayPercent: 41,
			sevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, 5 * 60_000);
		expect(events).toEqual([]);
		state = {
			sevenDayPercent: 2,
			sevenDayResetAt: nextSevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, 5 * 60_000);
		state = {
			sevenDayPercent: 25,
			sevenDayResetAt: nextSevenDayResetAt,
			savedResets: 0,
		};
		await refreshUsage(component, 5 * 60_000);
		state = {
			sevenDayPercent: 25.2,
			sevenDayResetAt: nextSevenDayResetAt,
			savedResets: 1,
		};
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([
			{ kind: "unscheduled-weekly-reset" },
			{ kind: "saved-reset-banked", added: 1, available: 1 },
		]);
		component.dispose();
	});

	it("compares weekly reset drops only within the same Codex quota tier", async () => {
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
			tier: "spark",
			plan: "pro",
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = { ...state, sevenDayPercent: 2, tier: undefined };
		await refreshUsage(component, 5 * 60_000);
		expect(events).toEqual([]);

		state = { ...state, sevenDayPercent: 42, tier: "spark" };
		await refreshUsage(component, 5 * 60_000);
		state = { ...state, sevenDayPercent: 2, sevenDayResetAt: sevenDayResetAt + 7 * 24 * 3_600_000 };
		await refreshUsage(component, 5 * 60_000);
		expect(events).toEqual([{ kind: "unscheduled-weekly-reset" }]);
		component.dispose();
	});

	it("binds each reset snapshot to the account identity used to normalize it", async () => {
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		const reports = [
			...codexUsageReport(
				{
					sevenDayPercent: 18,
					sevenDayResetAt,
					savedResets: 0,
				},
				"account-a",
			),
			...codexUsageReport(
				{
					sevenDayPercent: 22,
					sevenDayResetAt,
					savedResets: 1,
				},
				"account-b",
			),
		];
		const identityLookups: string[] = [];
		const component = new StatusLineComponent(
			makeCodexSession(
				async () => reports,
				() => ({ accountId: identityLookups.shift() ?? "account-a" }),
			),
			statusLineHost,
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		// The refresh starts under A, but B is active when its report is normalized.
		// A later identity lookup must not attribute B's saved reset to A.
		identityLookups.push("account-a", "account-b", "account-a");
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("does not attribute a workspace sibling's saved resets to the active credential", async () => {
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const workspaceId = "workspace-1";
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let bobSavedResets = 0;
		const component = new StatusLineComponent(
			makeCodexSession(
				async () => [
					...codexUsageReport(
						{ sevenDayPercent: 18, sevenDayResetAt, savedResets: 0 },
						workspaceId,
						"alice@example.com",
						workspaceId,
					),
					...codexUsageReport(
						{ sevenDayPercent: 22, sevenDayResetAt, savedResets: bobSavedResets },
						workspaceId,
						"bob@example.com",
						workspaceId,
					),
				],
				() => ({
					accountId: workspaceId,
					email: "alice@example.com",
					orgId: workspaceId,
				}),
			),
			statusLineHost,
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		bobSavedResets = 1;
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("keeps an unavailable saved-reset count unknown across refreshes", async () => {
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 18,
			sevenDayResetAt,
			savedResets: 1,
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = {
			sevenDayPercent: 18.1,
			sevenDayResetAt,
		};
		await refreshUsage(component, 5 * 60_000);
		state = { ...state, savedResets: 1 };
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("suppresses an early weekly drop when a prior saved-reset balance becomes unavailable", async () => {
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 1,
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = {
			sevenDayPercent: 0,
			sevenDayResetAt,
		};
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("does not infer an observation time when the provider omits fetchedAt", async () => {
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		let state: CodexUsageState = {
			sevenDayPercent: 42,
			sevenDayResetAt,
			savedResets: 0,
		};
		const component = new StatusLineComponent(
			makeCodexSession(async () => codexUsageReport(state)),
			statusLineHost,
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		await refreshUsage(component);
		state = {
			sevenDayPercent: 0,
			sevenDayResetAt,
			savedResets: 0,
			omitFetchedAt: true,
		};
		await refreshUsage(component, 5 * 60_000);

		expect(events).toEqual([]);
		component.dispose();
	});

	it("discards a timed-out report after a newer refresh applies", async () => {
		cfgTuiCodexResetFireworks.set(Settings.instance, true);
		const stale = Promise.withResolvers<unknown>();
		const sevenDayResetAt = Date.now() + 80 * 3_600_000;
		const current: CodexUsageState = {
			sevenDayPercent: 0,
			sevenDayResetAt,
			savedResets: 0,
		};
		let calls = 0;
		const component = new StatusLineComponent(
			makeCodexSession(async () => {
				calls++;
				return calls === 1 ? stale.promise : codexUsageReport(current);
			}),
			statusLineHost,
		);
		const events: CodexResetFireworksEvent[] = [];
		component.setCodexResetFireworksHandler(event => events.push(event));

		component.refreshUsageInBackground();
		vi.advanceTimersByTime(0);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();
		await refreshUsage(component, 5 * 60_000);
		expect(calls).toBe(2);

		stale.resolve(
			codexUsageReport({
				sevenDayPercent: 42,
				sevenDayResetAt,
				savedResets: 1,
			}),
		);
		await flushMicrotasks();
		await refreshUsage(component, 5 * 60_000);

		expect(calls).toBe(3);
		expect(events).toEqual([]);
		component.dispose();
	});
});
