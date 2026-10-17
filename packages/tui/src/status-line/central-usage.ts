import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { summarizeUsageResetCredits } from "../overlays/usage-display";
import {
	computeProviderWindowStats,
	isPooledUsageReport,
	meterForLimit,
	pooledWindowId,
	summarizePooledUsage,
} from "./pooled-usage";
import { CLAUDE_COLORS, renderUsageGauge } from "./segments";

export interface CentralUsageMetric {
	label: string;
	percent?: number;
	count?: number;
	resetsAt?: number;
	color: number;
}

/** Only display-safe scalars survive the fetch; never cache account metadata or raw responses. */
export interface CentralProviderUsage {
	provider: "openai-codex" | "anthropic";
	pooled: boolean;
	fetchedAt: number;
	metrics: CentralUsageMetric[];
}

const METERS: Readonly<Record<string, true>> = {
	chat: true,
	fable: true,
	ultrafast: true,
	spark: true,
	opus: true,
	sonnet: true,
	haiku: true,
	pro: true,
	max: true,
	plus: true,
};

/** Reports are local to the selected source. Account selection happens before aggregation. */
export function projectCentralUsage(
	reports: unknown,
	provider: CentralProviderUsage["provider"],
	matches: (report: UsageReport, limit?: UsageLimit) => boolean,
	hasIdentity: boolean,
): CentralProviderUsage {
	const result: CentralProviderUsage = { provider, pooled: false, fetchedAt: Date.now(), metrics: [] };
	if (!Array.isArray(reports)) return result;
	const candidates = reports.filter(
		(report): report is UsageReport =>
			!!report && typeof report === "object" && report.provider === provider && Array.isArray(report.limits),
	);
	const pooled = candidates.filter(isPooledUsageReport);
	result.pooled = pooled.length > 0;
	// A single unbound account is unambiguous; multiple unbound subscriptions are not.
	const selected = pooled.length
		? pooled
		: hasIdentity
			? candidates.filter(report => matches(report))
			: candidates.length === 1
				? candidates
				: [];
	const unique = new Map<unknown, UsageReport>();
	for (const report of selected) {
		const key = result.pooled ? report.metadata?.sprilicredAccountId : "active";
		const previous = unique.get(key);
		if (!previous || report.fetchedAt >= previous.fetchedAt) unique.set(key, report);
	}
	const scoped: UsageReport[] = [];
	for (const report of unique.values()) {
		const limits = report.limits
			.filter(
				limit =>
					!!limit &&
					typeof limit === "object" &&
					!!limit.scope &&
					typeof limit.scope === "object" &&
					!!limit.amount &&
					typeof limit.amount === "object" &&
					(typeof limit.scope.tier === "string" || limit.scope.tier === undefined) &&
					(!hasIdentity || result.pooled || matches(report, limit)),
			)
			.map(limit => {
				const windowId = pooledWindowId(limit);
				// Provider labels are presentation text ("5-hour", "Weekly total").
				// Normalize only this projection, preserving the canonical window and
				// tier before the shared capacity aggregator groups the limits.
				return {
					...limit,
					id: typeof limit.id === "string" ? limit.id : "",
					label: typeof limit.label === "string" ? limit.label : "",
					...(windowId
						? {
								window: {
									...limit.window,
									id: limit.window?.id ?? windowId,
									label: windowId === "7d:fable" ? "7d" : windowId,
								},
								scope: {
									...limit.scope,
									windowId: windowId === "7d:fable" ? "7d" : windowId,
									...(windowId === "7d:fable" && !limit.scope.tier ? { tier: "fable" } : {}),
								},
							}
						: {}),
				};
			});
		scoped.push({ ...report, limits });
		if (Number.isFinite(report.fetchedAt)) result.fetchedAt = Math.min(result.fetchedAt, report.fetchedAt);
	}
	const rawPlan = !result.pooled && scoped.length === 1 ? scoped[0]!.metadata?.planType : undefined;
	const plan = typeof rawPlan === "string" ? rawPlan.trim().toLowerCase() : undefined;
	if (plan && Object.hasOwn(METERS, plan)) {
		result.metrics.push({ label: `plan ${plan}`, color: CLAUDE_COLORS.effort });
	}
	const headline = result.pooled ? summarizePooledUsage(scoped)?.get(provider) : undefined;
	for (const stat of computeProviderWindowStats(scoped)) {
		if (!stat.accounts) continue;
		const short =
			stat.durationMs !== undefined ? Math.abs(stat.durationMs - 18_000_000) <= 60_000 : stat.window === "5h";
		const weekly =
			stat.durationMs !== undefined
				? Math.abs(stat.durationMs - 604_800_000) <= 60_000
				: /^(7d|weekly)$/i.test(stat.window);
		const meter =
			stat.meter && stat.meter !== "chat" ? (Object.hasOwn(METERS, stat.meter) ? stat.meter : "tier") : "";
		// Arbitrary server labels can contain private identifiers. Only durations and known windows are displayed.
		const window = short
			? "5h"
			: weekly
				? "wk"
				: stat.durationMs !== undefined && Number.isFinite(stat.durationMs) && stat.durationMs > 0
					? formatDuration(stat.durationMs)
					: /^(1d|daily|monthly|30d)$/i.test(stat.window)
						? stat.window.toLowerCase()
						: "quota";
		let percent = (stat.usedAccounts / stat.accounts) * 100;
		if (!meter && short && headline?.fiveHour) percent = headline.fiveHour.usedPercent;
		if (!meter && weekly && headline?.weekly) percent = headline.weekly.usedPercent;
		if (meter === "fable" && weekly && headline?.fableWeekly) percent = headline.fableWeekly.usedPercent;
		if (meter === "ultrafast" && headline?.ultrafastWeekly) percent = headline.ultrafastWeekly.usedPercent;
		if (!Number.isFinite(percent)) continue;
		const metric: CentralUsageMetric = {
			label: meter ? `${meter} ${window}` : window,
			percent,
			color: meter ? CLAUDE_COLORS.fable : short ? CLAUDE_COLORS.fiveHour : CLAUDE_COLORS.week,
		};
		// Pool accounts reset independently: do not invent one pool reset time.
		if (!result.pooled) {
			for (const report of scoped)
				for (const limit of report.limits) {
					const sameWindow =
						stat.durationMs !== undefined
							? limit.window?.durationMs === stat.durationMs
							: (limit.window?.label ?? limit.scope.windowId ?? limit.label) === stat.window;
					const limitMeter = meterForLimit(report, limit);
					const reset = limit.window?.resetsAt;
					if (sameWindow && limitMeter === stat.meter && typeof reset === "number" && Number.isFinite(reset))
						metric.resetsAt = Math.min(metric.resetsAt ?? reset, reset);
				}
		}
		result.metrics.push(metric);
	}
	// Pool reports were deduplicated by account above; never aggregate across chats or hosts.
	let banked: number | undefined;
	let usable = 0;
	let expiry: number | undefined;
	for (const report of scoped) {
		const reset = summarizeUsageResetCredits(report.resetCredits);
		if (!reset || !Number.isFinite(reset.bankedCount) || !Number.isFinite(reset.redeemableCount)) continue;
		banked = (banked ?? 0) + reset.bankedCount;
		usable += reset.redeemableCount;
		const at = reset.soonestExpiry ? Date.parse(reset.soonestExpiry) : undefined;
		if (at !== undefined && Number.isFinite(at)) expiry = Math.min(expiry ?? at, at);
	}
	if (banked !== undefined) {
		result.metrics.push({ label: "resets", count: banked, color: CLAUDE_COLORS.session });
		result.metrics.push({ label: "usable", count: usable, color: CLAUDE_COLORS.session });
		if (expiry !== undefined)
			result.metrics.push({ label: "expiry", resetsAt: expiry, color: CLAUDE_COLORS.session });
	}
	return result;
}

export function renderCentralUsage(usage: CentralProviderUsage, stale: boolean): string[] {
	const name = usage.provider === "openai-codex" ? "Codex" : "Claude";
	const suffix =
		usage.metrics.length === 0 ? " unavailable" : stale || Date.now() - usage.fetchedAt >= 300_000 ? " stale" : "";
	const lines = [`\x1b[38;5;${CLAUDE_COLORS.model}m${name}${usage.pooled ? " pool" : ""}${suffix}\x1b[39m`];
	for (const metric of usage.metrics) {
		let text =
			metric.percent !== undefined
				? renderUsageGauge(metric.color, metric.label, metric.percent)
				: `\x1b[38;5;${metric.color}m${metric.label}${metric.count !== undefined ? ` ${metric.count}` : ""}\x1b[39m`;
		if (metric.resetsAt !== undefined)
			text += ` \x1b[38;5;${metric.color}m${metric.resetsAt <= Date.now() ? "due" : formatDuration(metric.resetsAt - Date.now())}\x1b[39m`;
		lines.push(text);
	}
	return lines;
}
