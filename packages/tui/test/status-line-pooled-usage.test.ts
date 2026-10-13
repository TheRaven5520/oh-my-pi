import { describe, expect, it } from "bun:test";
import { pooledProviderMatches, pooledUsageProvider, summarizePooledUsage } from "../src/status-line/pooled-usage";

function pooledReport(
	provider: string,
	account: string,
	limits: Array<[id: string, usedFraction: number, label?: string]>,
) {
	return {
		provider,
		fetchedAt: 0,
		metadata: { sprilicredAccountId: account },
		limits: limits.map(([id, usedFraction, label]) => ({
			id,
			label: label ?? id,
			window: { id, label: label ?? id },
			scope: { provider, windowId: id },
			amount: { usedFraction, used: usedFraction * 100, unit: "percent" },
		})),
	};
}

describe("summarizePooledUsage", () => {
	it("averages each pooled dashboard window independently", () => {
		const summary = summarizePooledUsage([
			pooledReport("anthropic", "a", [
				["5h", 0],
				["7d", 0.95],
				["7d:fable", 0.8],
			]),
			pooledReport("anthropic", "b", [
				["5h", 0.36],
				["7d", 0.6],
				["7d:fable", 0.7],
			]),
			pooledReport("anthropic", "c", [
				["5h", 0.1],
				["7d", 0.4],
				["7d:fable", 0.9],
			]),
			// Reports 5h and 7d but no Fable cap: counts toward those two headlines only.
			pooledReport("anthropic", "d", [
				["5h", 0.05],
				["7d", 0.2],
			]),
		]);
		const anthropic = summary?.get("anthropic");
		expect(anthropic?.accounts).toBe(4);
		expect(anthropic?.fiveHour?.usedPercent).toBeCloseTo(12.75);
		expect(anthropic?.weekly?.usedPercent).toBeCloseTo(53.75);
		// Fable uses only the provider's 7d:fable rows: a=80, b=70, c=90.
		expect(anthropic?.fableWeekly?.usedPercent).toBeCloseTo(80);
	});

	it("recognizes Fable ids with a shared seven-day scope", () => {
		const report = pooledReport("anthropic", "fable", [["anthropic:7d:fable", 0.6, "7 Day"]]);
		const limit = report.limits[0]!;
		limit.window = { id: "7d", label: "7 Day" };
		limit.scope = { provider: "anthropic", windowId: "7d" };
		Object.assign(limit.scope, { tier: "fable" });
		const summary = summarizePooledUsage([report]);
		expect(summary?.get("anthropic")?.fableWeekly?.usedPercent).toBeCloseTo(60);
	});

	it("uses aggregate OpenAI weekly capacity and ignores nonexistent five-hour windows", () => {
		const summary = summarizePooledUsage([
			pooledReport("openai-codex", "x", [
				["chat:primary", 0.01, "Five Hour"],
				["chat:secondary", 1, "Weekly"],
			]),
			pooledReport("openai-codex", "y", [["chat:secondary", 0.25, "Weekly"]]),
		]);
		const codex = summary?.get("openai-codex");
		expect(codex?.weekly?.usedPercent).toBeCloseTo(62.5);
		expect(codex?.fiveHour).toBeUndefined();
		expect(codex?.fableWeekly).toBeUndefined();
	});

	it("averages Sprilicred's Ultrafast rows over the Pro 500 accounts only, apart from the weekly", () => {
		const ultrafast = (account: string, weekly: number, used: number) => {
			const report = pooledReport("openai-codex", account, [
				["chat:secondary", weekly, "Weekly"],
				["ultrafast", used, "Weekly"],
			]);
			report.limits[1]!.label = "Ultrafast (GPT-6 Astra)";
			report.limits[1]!.scope = { provider: "openai-codex", windowId: "chat:secondary" };
			Object.assign(report.limits[1]!.scope, { tier: "ultrafast" });
			return report;
		};
		const summary = summarizePooledUsage([
			ultrafast("max-a", 0.2, 0.2),
			ultrafast("max-b", 0.6, 0.6),
			pooledReport("openai-codex", "pro", [["chat:secondary", 1, "Weekly"]]),
		]);
		const codex = summary?.get("openai-codex");
		// Weekly over all three accounts; Ultrafast over the two that report it.
		expect(codex?.weekly?.usedPercent).toBeCloseTo(60);
		expect(codex?.ultrafastWeekly?.usedPercent).toBeCloseTo(40);
	});

	it("reports no Ultrafast figure for an OpenAI pool without Pro 500 accounts", () => {
		const summary = summarizePooledUsage([pooledReport("openai-codex", "pro", [["chat:secondary", 0.5, "Weekly"]])]);
		expect(summary?.get("openai-codex")?.ultrafastWeekly).toBeUndefined();
	});

	it("identifies weekly quota by duration or label, not primary/secondary position", () => {
		const report = pooledReport("openai-codex", "a", [
			["chat:primary", 0.8, "Weekly"],
			["chat:secondary", 0.1, "Five Hour"],
		]);
		expect(summarizePooledUsage([report])?.get("openai-codex")?.weekly?.usedPercent).toBeCloseTo(80);
		const durationReports = [
			{
				...report,
				limits: report.limits.map((limit, index) => ({
					...limit,
					window: { ...limit.window, label: "Quota", durationMs: index === 0 ? 604_800_000 : 18_000_000 },
				})),
			},
		];
		expect(summarizePooledUsage(durationReports)?.get("openai-codex")?.weekly?.usedPercent).toBeCloseTo(80);
		expect(summarizePooledUsage([pooledReport("openai-codex", "a", [["chat:secondary", 0.1]])])).toBeNull();
	});

	it("ignores reports that are not pooled", () => {
		expect(
			summarizePooledUsage([
				{ provider: "anthropic", limits: [{ id: "5h", amount: { usedFraction: 0.5 } }], metadata: {} },
			]),
		).toBeNull();
	});
});

describe("pooledProviderMatches", () => {
	it("maps sprilicred catalog providers onto upstream report providers", () => {
		expect(pooledProviderMatches("sprilicred-anthropic", "anthropic")).toBe(true);
		expect(pooledProviderMatches("sprilicred-openai", "openai-codex")).toBe(true);
		expect(pooledProviderMatches("sprilicred-anthropic", "openai-codex")).toBe(false);
		expect(pooledProviderMatches("anthropic", "anthropic")).toBe(true);
	});

	it("does not treat missing, metered, or prefix-related providers as subscription pools", () => {
		for (const provider of [undefined, "openai", "openrouter", "sprilicred-openrouter", "sprilicred-glm"]) {
			expect(pooledProviderMatches(provider, "anthropic")).toBe(false);
			expect(pooledProviderMatches(provider, "openai-codex")).toBe(false);
		}
		expect(pooledProviderMatches("anthropic", "anthropic-other")).toBe(false);
	});

	it("uses discovery source instead of a misleading credential alias", () => {
		expect(pooledUsageProvider({ provider: "sprilicred-anthropic", providerType: "openrouter" })).toBeUndefined();
		expect(pooledUsageProvider({ provider: "sprilicred-openai", providerType: "openai" })).toBeUndefined();
		expect(pooledUsageProvider({ provider: "personal-claude", providerType: "anthropic" })).toBe("anthropic");
		expect(pooledUsageProvider({ provider: "personal-codex", providerType: "openai-codex" })).toBe("openai-codex");
	});

	it("requires matching model lineage on generic Sprilicred routes", () => {
		expect(pooledUsageProvider({ provider: "sprilicred-openai", identity: { class: "openai" } })).toBe(
			"openai-codex",
		);
		expect(pooledUsageProvider({ provider: "sprilicred-anthropic", identity: { class: "anthropic" } })).toBe(
			"anthropic",
		);
		for (const identity of [
			undefined,
			{ class: "unknown" },
			{ class: "glm" },
			{ class: "deepseek" },
			{ class: "anthropic" },
		]) {
			expect(pooledUsageProvider({ provider: "sprilicred-openai", identity })).toBeUndefined();
		}
	});

	it("does not inherit subscription quotas after an endpoint reroute", () => {
		for (const baseUrl of [
			"https://openrouter.ai/api/v1",
			"https://gateway.example/openrouter/v1",
			"https://gateway.example/glm/v1",
			"https://gateway.example/deepseek/v1",
		]) {
			expect(
				pooledUsageProvider({ provider: "anthropic", baseUrl, identity: { class: "anthropic" } }),
			).toBeUndefined();
			expect(
				pooledUsageProvider({ provider: "openai-codex", baseUrl, identity: { class: "openai" } }),
			).toBeUndefined();
		}
	});
});
