/**
 * Agent run stats in Claude Code's format: `12 tool uses · 34.5k tokens · 1m 23s`.
 */

/** Tool calls, tokens and elapsed time of one agent run; unknown or zero parts are left out. */
export interface AgentRunStats {
	tools?: number;
	tokens?: number;
	elapsedMs?: number;
}

const compactTokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** `950`, `12k`, `34.5k`, `1.3m`. */
export function formatCompactTokens(tokens: number): string {
	return compactTokens.format(Math.max(0, Math.round(tokens))).toLowerCase();
}

/** `45s`, `1m 23s`, `2m`, `1h 5m`. */
export function formatRunElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function positive(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The stats joined with ` · `, or an empty string when nothing is known yet. */
export function formatAgentRunStats(stats: AgentRunStats): string {
	const parts: string[] = [];
	if (positive(stats.tools)) parts.push(stats.tools === 1 ? "1 tool use" : `${stats.tools} tool uses`);
	if (positive(stats.tokens)) parts.push(`${formatCompactTokens(stats.tokens)} tokens`);
	if (typeof stats.elapsedMs === "number" && Number.isFinite(stats.elapsedMs) && stats.elapsedMs >= 0) {
		parts.push(formatRunElapsed(stats.elapsedMs));
	}
	return parts.join(" · ");
}
