import { describe, expect, it } from "bun:test";
import { pooledProviderMatches, summarizePooledUsage } from "../src/status-line/pooled-usage";

function pooledReport(provider: string, account: string, limits: Array<[id: string, usedFraction: number]>) {
	return {
		provider,
		fetchedAt: 0,
		metadata: { sprilicredAccountId: account },
		limits: limits.map(([id, usedFraction]) => ({
			id,
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

	it("maps Codex chat windows and omits windows no account reports", () => {
		const summary = summarizePooledUsage([
			pooledReport("openai-codex", "x", [["chat:secondary", 1]]),
			pooledReport("openai-codex", "y", [["chat:secondary", 0.25]]),
		]);
		const codex = summary?.get("openai-codex");
		expect(codex?.weekly?.usedPercent).toBeCloseTo(25);
		expect(codex?.fiveHour).toBeUndefined();
		expect(codex?.fableWeekly).toBeUndefined();
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
