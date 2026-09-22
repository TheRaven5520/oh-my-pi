/**
 * Pool headline over Sprilicred's pooled usage reports.
 *
 * Anthropic routing needs the best headroom any account still has for a
 * request. OpenAI's pooled weekly meter is different: the broker exposes one
 * fleet capacity meter, so its usage is the sum of each account's used share
 * divided by the reporting account count. This mirrors `omp usage --json`'s
 * `capacity` field instead of showing the least-used account as the pool.
 */

export interface PooledUsageWindow {
	/** Share of the window already spent, 0–100, from the best-headroom account. */
	usedPercent: number;
}

export interface PooledProviderUsage {
	/** Pooled accounts that reported at least one recognized window. */
	accounts: number;
	fiveHour?: PooledUsageWindow;
	weekly?: PooledUsageWindow;
	/** Anthropic only: the tighter of the shared weekly and the Fable-scoped weekly. */
	fableWeekly?: PooledUsageWindow;
}

/** Keyed by report provider (`anthropic`, `openai-codex`, …). */
export type PooledUsageSummary = ReadonlyMap<string, PooledProviderUsage>;

type PooledWindowId = "5h" | "7d" | "7d:fable";

/** Window ids as Sprilicred labels them per upstream provider. */
const POOLED_WINDOW_IDS: Readonly<Record<string, PooledWindowId>> = {
	"5h": "5h",
	"7d": "7d",
	"7d:fable": "7d:fable",
	// OpenAI Codex: secondary is the only reported ChatGPT quota window.
	"chat:secondary": "7d",
};

/** A usage report Sprilicred produced for one of its pooled accounts. */
export function isPooledUsageReport(report: unknown): report is object {
	if (!report || typeof report !== "object" || !("metadata" in report)) return false;
	const { metadata } = report;
	return (
		!!metadata &&
		typeof metadata === "object" &&
		"sprilicredAccountId" in metadata &&
		metadata.sprilicredAccountId != null
	);
}

/**
 * Whether pooled reports for `reportProvider` back the session's `activeProvider`.
 * Sprilicred models are catalogued as `sprilicred-anthropic` / `sprilicred-openai`
 * while its reports carry the upstream provider (`anthropic`, `openai-codex`).
 */
export function pooledProviderMatches(activeProvider: string | undefined, reportProvider: string): boolean {
	if (!activeProvider) return true;
	if (reportProvider === activeProvider) return true;
	const base = activeProvider.replace(/^sprilicred-/, "");
	return reportProvider === base || reportProvider.startsWith(`${base}-`);
}

function remainingPercent(limit: object): number | undefined {
	if (!("amount" in limit) || !limit.amount || typeof limit.amount !== "object") return undefined;
	const { amount } = limit;
	const usedFraction = "usedFraction" in amount ? amount.usedFraction : undefined;
	const used = "used" in amount ? amount.used : undefined;
	const usedPct =
		typeof usedFraction === "number" && Number.isFinite(usedFraction)
			? usedFraction * 100
			: typeof used === "number" && Number.isFinite(used)
				? used
				: undefined;
	if (usedPct === undefined) return undefined;
	return Math.min(100, Math.max(0, 100 - usedPct));
}

function pooledWindowId(limit: object): PooledWindowId | undefined {
	const scope = "scope" in limit ? limit.scope : undefined;
	const fromScope = scope && typeof scope === "object" && "windowId" in scope ? scope.windowId : undefined;
	const fromId = "id" in limit ? limit.id : undefined;
	for (const candidate of [fromScope, fromId]) {
		if (typeof candidate === "string" && Object.hasOwn(POOLED_WINDOW_IDS, candidate))
			return POOLED_WINDOW_IDS[candidate];
	}
	return undefined;
}

/** Best remaining share any account has across all of `ids`, or undefined when none reports them all. */
function bestRemaining(
	accounts: ReadonlyArray<ReadonlyMap<PooledWindowId, number>>,
	ids: readonly PooledWindowId[],
): number | undefined {
	let best: number | undefined;
	for (const account of accounts) {
		let tightest: number | undefined;
		for (const id of ids) {
			const remaining = account.get(id);
			if (remaining === undefined) {
				tightest = undefined;
				break;
			}
			tightest = tightest === undefined ? remaining : Math.min(tightest, remaining);
		}
		if (tightest === undefined) continue;
		best = best === undefined ? tightest : Math.max(best, tightest);
	}
	return best;
}

function toWindow(bestRemainingPercent: number | undefined): PooledUsageWindow | undefined {
	return bestRemainingPercent === undefined ? undefined : { usedPercent: 100 - bestRemainingPercent };
}

/** Average used share across accounts reporting every requested window. */
function averageUsedPercent(
	accounts: ReadonlyArray<ReadonlyMap<PooledWindowId, number>>,
	ids: readonly PooledWindowId[],
): number | undefined {
	let total = 0;
	let count = 0;
	for (const account of accounts) {
		let tightest: number | undefined;
		for (const id of ids) {
			const remaining = account.get(id);
			if (remaining === undefined) {
				tightest = undefined;
				break;
			}
			tightest = tightest === undefined ? remaining : Math.min(tightest, remaining);
		}
		if (tightest === undefined) continue;
		total += 100 - tightest;
		count += 1;
	}
	return count === 0 ? undefined : total / count;
}

/** Summarize pooled reports per provider; null when `reports` holds no pooled account with a recognized window. */
export function summarizePooledUsage(reports: unknown): PooledUsageSummary | null {
	if (!Array.isArray(reports)) return null;
	// Provider → one window→remaining map per pooled account (dynamic keys, built at runtime).
	const byProvider = new Map<string, Array<Map<PooledWindowId, number>>>();
	for (const report of reports) {
		if (!isPooledUsageReport(report)) continue;
		const provider = "provider" in report ? report.provider : undefined;
		const limits = "limits" in report ? report.limits : undefined;
		if (typeof provider !== "string" || !Array.isArray(limits)) continue;
		const windows = new Map<PooledWindowId, number>();
		for (const limit of limits) {
			if (!limit || typeof limit !== "object") continue;
			const id = pooledWindowId(limit);
			const remaining = remainingPercent(limit);
			if (id === undefined || remaining === undefined) continue;
			// Duplicate ids within one account keep the tighter reading.
			const prior = windows.get(id);
			windows.set(id, prior === undefined ? remaining : Math.min(prior, remaining));
		}
		if (windows.size === 0) continue;
		const accounts = byProvider.get(provider);
		if (accounts) accounts.push(windows);
		else byProvider.set(provider, [windows]);
	}
	if (byProvider.size === 0) return null;
	const summary = new Map<string, PooledProviderUsage>();
	for (const [provider, accounts] of byProvider) {
		const entry: PooledProviderUsage = { accounts: accounts.length };
		const weekly =
			provider === "openai-codex"
				? (() => {
						const usedPercent = averageUsedPercent(accounts, ["7d"]);
						return usedPercent === undefined ? undefined : { usedPercent };
					})()
				: toWindow(bestRemaining(accounts, ["7d"]));
		const fableWeekly = toWindow(bestRemaining(accounts, ["7d", "7d:fable"]));
		if (provider !== "openai-codex") {
			const fiveHour = toWindow(bestRemaining(accounts, ["5h"]));
			if (fiveHour) entry.fiveHour = fiveHour;
		}
		if (weekly) entry.weekly = weekly;
		if (fableWeekly) entry.fableWeekly = fableWeekly;
		summary.set(provider, entry);
	}
	return summary;
}
