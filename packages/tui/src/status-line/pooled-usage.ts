import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";

/**
 * Pool headline over Sprilicred's pooled usage reports.
 *
 * Each account's used share for a named window is averaged across the enabled
 * pool accounts reporting that window. This matches Sprilicred's Overview pool
 * gauges; Fable is the provider's exact `7d:fable` window, not a synthetic
 * tighter-of-two bucket. OpenAI's pooled weekly headline is computed by
 * `computeProviderWindowStats`, shared with `omp usage --json`.
 */

export interface PooledUsageWindow {
	/** Average used share across pooled accounts, 0–100. */
	usedPercent: number;
}

export interface PooledProviderUsage {
	/** Pooled accounts that reported at least one recognized window. */
	accounts: number;
	fiveHour?: PooledUsageWindow;
	weekly?: PooledUsageWindow;
	/** Anthropic only: the provider's pooled `7d:fable` average. */
	fableWeekly?: PooledUsageWindow;
}

/** Keyed by report provider (`anthropic`, `openai-codex`, …). */
export type PooledUsageSummary = ReadonlyMap<string, PooledProviderUsage>;

type PooledWindowId = "5h" | "7d" | "7d:fable";

/** Window labels and ids emitted by Sprilicred/upstream providers. */
const POOLED_WINDOW_IDS: Readonly<Record<string, PooledWindowId>> = {
	"5h": "5h",
	"7d": "7d",
	"7d:fable": "7d:fable",
};

/** A usage report Sprilicred produced for one of its pooled accounts. */
export function isPooledUsageReport(report: unknown): report is UsageReport {
	if (!report || typeof report !== "object" || !("metadata" in report)) return false;
	if (
		!("provider" in report) ||
		typeof report.provider !== "string" ||
		!("limits" in report) ||
		!Array.isArray(report.limits)
	)
		return false;
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
	const window = "window" in limit ? limit.window : undefined;
	const windowObject = window && typeof window === "object" ? window : undefined;
	const scopeObject = scope && typeof scope === "object" ? scope : undefined;
	const rawId = "id" in limit ? limit.id : undefined;
	const scopeTier = scopeObject && "tier" in scopeObject ? scopeObject.tier : undefined;
	const scopeWindowId = scopeObject && "windowId" in scopeObject ? scopeObject.windowId : undefined;
	const normalizedRawId = typeof rawId === "string" ? rawId.trim().toLowerCase() : undefined;
	const normalizedTier = typeof scopeTier === "string" ? scopeTier.trim().toLowerCase() : undefined;
	const normalizedScopeWindowId = typeof scopeWindowId === "string" ? scopeWindowId.trim().toLowerCase() : undefined;
	if (
		normalizedRawId === "7d:fable" ||
		normalizedRawId?.endsWith(":7d:fable") ||
		(normalizedTier === "fable" && normalizedScopeWindowId === "7d")
	)
		return "7d:fable";
	const candidates = [
		windowObject && "label" in windowObject ? windowObject.label : undefined,
		windowObject && "id" in windowObject ? windowObject.id : undefined,
		scopeObject && "windowId" in scopeObject ? scopeObject.windowId : undefined,
		rawId,
	];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const normalized = candidate.trim().toLowerCase();
		if (normalized === "5 hour" || normalized === "five hour") return "5h";
		if (normalized === "weekly" || normalized === "7 day") return "7d";
		if (normalized === "7d:fable") return "7d:fable";
		if (Object.hasOwn(POOLED_WINDOW_IDS, candidate)) return POOLED_WINDOW_IDS[candidate];
	}
	return undefined;
}

/** Per-window capacity stat shared by `omp usage` and the TUI. */
export interface ProviderWindowStat {
	/** Compact window label, e.g. `5h`, `7d`, or `Weekly`. */
	window: string;
	durationMs?: number;
	/** Meter identity when a provider keeps independent meters in one window. */
	meter?: string;
	/** Accounts reporting a limit in this window. */
	accounts: number;
	/** Sum of each account's binding used fraction - accounts' worth of quota burned. */
	usedAccounts: number;
	/** Accounts' worth of quota still available across reporting accounts. */
	remainingAccounts: number;
}

function meterForLimit(report: UsageReport, limit: UsageLimit): string | undefined {
	if (report.provider !== "openai-codex") return undefined;
	const tier = limit.scope.tier?.trim().toLowerCase();
	if (tier) return tier;
	const slug = limit.id.toLowerCase().split(":")[1];
	return slug && slug !== "primary" && slug !== "secondary" ? slug : "chat";
}

/** Aggregate one provider's reports into per-window quota capacity stats. */
export function computeProviderWindowStats(reports: UsageReport[]): ProviderWindowStat[] {
	const buckets = new Map<string, { window: string; durationMs?: number; meter?: string; fractions: number[] }>();
	for (const report of reports) {
		const accountMax = new Map<string, number>();
		for (const limit of report.limits) {
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const durationMs = limit.window?.durationMs;
			const windowKey =
				durationMs !== undefined ? `d:${durationMs}` : (limit.scope.windowId ?? limit.window?.label ?? limit.label);
			const meter = meterForLimit(report, limit);
			const key = meter === undefined ? windowKey : `m:${meter}\0${windowKey}`;
			const previous = accountMax.get(key);
			if (previous === undefined || fraction > previous) accountMax.set(key, fraction);
			if (!buckets.has(key)) {
				const window =
					durationMs !== undefined
						? formatDuration(durationMs)
						: (limit.window?.label ?? limit.scope.windowId ?? limit.label);
				buckets.set(key, { window, durationMs, meter, fractions: [] });
			}
		}
		for (const [key, fraction] of accountMax) buckets.get(key)?.fractions.push(fraction);
	}
	return [...buckets.values()]
		.sort((a, b) => {
			const duration = (a.durationMs ?? Number.POSITIVE_INFINITY) - (b.durationMs ?? Number.POSITIVE_INFINITY);
			return duration !== 0 ? duration : (a.meter ?? "").localeCompare(b.meter ?? "");
		})
		.map(bucket => {
			const usedAccounts = bucket.fractions.reduce((sum, fraction) => sum + fraction, 0);
			return {
				window: bucket.window,
				durationMs: bucket.durationMs,
				...(bucket.meter === undefined ? {} : { meter: bucket.meter }),
				accounts: bucket.fractions.length,
				usedAccounts,
				remainingAccounts: Math.max(0, bucket.fractions.length - usedAccounts),
			};
		});
}

/** Average used share across accounts reporting one named window. */
function averageUsedPercent(
	accounts: ReadonlyArray<ReadonlyMap<PooledWindowId, number>>,
	id: PooledWindowId,
): number | undefined {
	let total = 0;
	let count = 0;
	for (const account of accounts) {
		const remaining = account.get(id);
		if (remaining === undefined) continue;
		total += 100 - remaining;
		count++;
	}
	return count === 0 ? undefined : total / count;
}

function toWindow(usedPercent: number | undefined): PooledUsageWindow | undefined {
	return usedPercent === undefined ? undefined : { usedPercent };
}

/** Summarize pooled reports per provider; null when `reports` holds no pooled account with a recognized window. */
export function summarizePooledUsage(reports: unknown): PooledUsageSummary | null {
	if (!Array.isArray(reports)) return null;
	// Provider → one window→remaining map per pooled account (dynamic keys, built at runtime).
	const byProvider = new Map<string, Array<Map<PooledWindowId, number>>>();
	const codexReports: UsageReport[] = [];
	for (const report of reports) {
		if (!isPooledUsageReport(report)) continue;
		const provider = report.provider;
		if (provider === "openai-codex") {
			codexReports.push(report);
			continue;
		}
		const windows = new Map<PooledWindowId, number>();
		for (const limit of report.limits) {
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
	const summary = new Map<string, PooledProviderUsage>();
	for (const [provider, accounts] of byProvider) {
		const entry: PooledProviderUsage = { accounts: accounts.length };
		const weekly = toWindow(averageUsedPercent(accounts, "7d"));
		const fableWeekly = toWindow(averageUsedPercent(accounts, "7d:fable"));
		const fiveHour = toWindow(averageUsedPercent(accounts, "5h"));
		if (fiveHour) entry.fiveHour = fiveHour;
		if (weekly) entry.weekly = weekly;
		if (fableWeekly) entry.fableWeekly = fableWeekly;
		summary.set(provider, entry);
	}
	const weekly = computeProviderWindowStats(codexReports).find(stat => {
		if (stat.meter !== "chat") return false;
		// Some provider windows are reported a minute short of seven days.
		if (stat.durationMs !== undefined) return Math.abs(stat.durationMs - 7 * 86_400_000) <= 60_000;
		return stat.window.toLowerCase() === "weekly" || stat.window === "7d";
	});
	if (weekly) {
		summary.set("openai-codex", {
			accounts: weekly.accounts,
			weekly: { usedPercent: (weekly.usedAccounts / weekly.accounts) * 100 },
		});
	}
	return summary.size === 0 ? null : summary;
}
