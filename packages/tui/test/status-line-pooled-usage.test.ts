import { describe, expect, it } from "bun:test";
import { pooledProviderMatches, summarizePooledUsage } from "../src/status-line/pooled-usage";

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
	it("takes the best headroom across accounts and the tighter window for fable", () => {
		const summary = summarizePooledUsage([
			pooledReport("anthropic", "a", [
				["5h", 0],
				["7d", 0.95],
				["7d:fable", 1],
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
		expect(anthropic?.fiveHour?.usedPercent).toBe(0);
		expect(anthropic?.weekly?.usedPercent).toBeCloseTo(20);
		// Fable per account = max(7d, 7d:fable): a=100, b=70, c=90, d ineligible → best is b.
		expect(anthropic?.fableWeekly?.usedPercent).toBeCloseTo(70);
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
});
