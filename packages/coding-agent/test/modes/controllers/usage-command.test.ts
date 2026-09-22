import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController, renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { OAuthAccountIdentity } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";

describe("renderUsageReports content", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", () => {
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 98));
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", () => {
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders Claude banked reset availability and the next expiry", () => {
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "anthropic",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					redeemableCount: 0,
					reason: "weekly cooldown",
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain("0 usable now");
		expect(output).toContain("unavailable: weekly cooldown");
		expect(output).not.toContain(`expired (${expiredIso.slice(0, 10)})`);
	});

	it("shows one prepaid balance for a provider whose keys share an account pool", () => {
		// Production shape: `fetchCharmHyperUsage` emits no accountId and marks
		// the limit shared, because Hyper's balance is account-wide — spending
		// through one key moves every key's reported balance. AuthStorage still
		// probes once per stored key, so two keys yield two identical rows.
		// Summing them would claim 200 credits the account never had.
		const now = Date.now();
		const keyReport = (remaining: number): UsageReport => ({
			provider: "charm-hyper",
			fetchedAt: now,
			limits: [
				{
					id: "charm-hyper:credits",
					label: "Credit balance",
					scope: { provider: "charm-hyper", windowId: "balance", shared: true },
					amount: { remaining, unit: "credits" },
				},
			],
		});

		const output = stripVTControlCharacters(renderUsageReports([keyReport(100), keyReport(100)], theme, now, 98));
		expect(output).toContain("100 credits left");
		expect(output).not.toContain("200 credits left");
		// The balance must reach the user at all: a remaining-only limit used
		// to fall through to a bare account count.
		expect(output).not.toContain("accts");
	});

	it("renders each marked Antigravity shared quota once in expanded details", () => {
		const quota = (
			counter: "google" | "anthropic" | "openai",
			windowId: "5h" | "weekly",
		): UsageReport["limits"][number] => {
			const sharedGroup = counter === "google" ? undefined : `3p-${windowId}`;
			return {
				id: `google-antigravity:${counter}:default:${counter === "google" ? "gemini" : "3p"}-${windowId}`,
				label: counter === "google" ? "Gemini" : "Claude & GPT (shared)",
				scope: {
					provider: "google-antigravity",
					accountId: "account",
					windowId,
					...(sharedGroup !== undefined ? { shared: true, sharedGroup } : {}),
				},
				window: { id: windowId, label: windowId === "5h" ? "5 Hour" : "Weekly" },
				amount: { unit: "percent", usedFraction: 0.25 },
				status: "ok",
			};
		};
		const reports: UsageReport[] = [
			{
				provider: "google-antigravity",
				fetchedAt: Date.now(),
				limits: [
					quota("google", "5h"),
					quota("google", "weekly"),
					quota("anthropic", "5h"),
					quota("openai", "5h"),
					quota("anthropic", "weekly"),
					quota("openai", "weekly"),
				],
				metadata: { email: "user@example.test" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));

		expect(output.match(/Claude & GPT \(shared\)/g)).toHaveLength(2);
		expect(output.match(/Gemini/g)).toHaveLength(2);
	});
});

const now = 1_700_000_005_000;

function accountReport(provider: string, email: string, usedFraction = 0.2): UsageReport {
	return {
		provider,
		fetchedAt: now - 5_000,
		metadata: { email },
		limits: [
			{
				id:
					provider === "anthropic"
						? "anthropic:7d:fable"
						: provider === "openai-codex"
							? "openai-codex:secondary"
							: "weekly",
				label: provider === "anthropic" ? "Fable weekly" : "Weekly",
				scope: { provider, windowId: "7d", ...(provider === "anthropic" ? { tier: "fable" } : {}) },
				window: { id: "7d", label: "Weekly", durationMs: 604_740_000, resetsAt: now + 3_600_000 },
				amount: { usedFraction, unit: "percent" },
				status: usedFraction >= 1 ? "exhausted" : "ok",
			},
		],
	};
}

async function renderLiveReports(
	reports: UsageReport[],
	{
		width = 120,
		height = 40,
		activeAccount,
		raw = false,
	}: { width?: number; height?: number; activeAccount?: OAuthAccountIdentity; raw?: boolean } = {},
): Promise<string> {
	const liveUsageContainer = new Container();
	const fetchUsageReports = vi.fn(async () => reports);
	const ctx = {
		session: {
			sessionId: "usage-formatting-test",
			model: activeAccount ? { provider: "anthropic" } : undefined,
			modelRegistry: { authStorage: { getOAuthAccountIdentity: () => activeAccount } },
			fetchUsageReports,
			getUsageReportingModelSelectors: () => [],
		},
		ui: { terminal: { columns: width, rows: height }, requestRender: vi.fn() },
		liveUsageContainer,
	} as unknown as InteractiveModeContext;
	const controller = new CommandController(ctx);
	try {
		controller.setLiveUsageEnabled(true);
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		expect(liveUsageContainer.children).toHaveLength(1);
		const rendered = liveUsageContainer.render(width);
		const rows = rendered.map(stripVTControlCharacters);
		expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
		expect(rows.at(-1)).toContain("/usage off");
		expect(rows.at(-1)).toContain("30s");
		const output = rows.join("\n");
		expect(output).toContain("Live usage");
		expect(output).toContain("/usage off");
		return raw ? rendered.join("\n") : output;
	} finally {
		controller.setLiveUsageEnabled(false);
		expect(liveUsageContainer.children).toHaveLength(0);
	}
}

describe("CommandController live /usage rendering", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(now);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("selects only Fable and main Codex weekly usage and their reset countdowns", async () => {
		const claude = accountReport("anthropic", "claude@example.test", 0.85);
		claude.limits[0].window!.resetsAt = now + 2 * 86_400_000;
		claude.limits.unshift(
			{
				...claude.limits[0],
				id: "anthropic:7d",
				label: "Shared weekly",
				scope: { provider: "anthropic", windowId: "7d", shared: true },
				amount: { usedFraction: 1, unit: "percent" },
				status: "exhausted",
				window: { id: "7d", label: "7d", resetsAt: now + 60_000 },
			},
			{
				...claude.limits[0],
				id: "anthropic:7d:sonnet",
				label: "Sonnet weekly",
				scope: { provider: "anthropic", tier: "sonnet", windowId: "7d" },
				amount: { usedFraction: 0.1, unit: "percent" },
				window: { id: "7d", label: "7d", resetsAt: now + 120_000 },
			},
		);
		const codex = accountReport("openai-codex", "codex@example.test");
		codex.limits[0].amount = { remainingFraction: 0.25, unit: "requests" };
		codex.limits[0].window!.resetsAt = now + 86_400_000;
		codex.limits.unshift(
			{
				...codex.limits[0],
				id: "openai-codex:primary",
				label: "Session",
				scope: { provider: "openai-codex", windowId: "5h", shared: true },
				window: { id: "5h", label: "5h", durationMs: 18_000_000, resetsAt: now + 180_000 },
				amount: { usedFraction: 0.1, unit: "percent" },
			},
			{
				...codex.limits[0],
				id: "openai-codex:spark:secondary",
				label: "Spark weekly",
				scope: { provider: "openai-codex", windowId: "7d", shared: true },
				window: { id: "7d", label: "7d", resetsAt: now + 240_000 },
				amount: { usedFraction: 1, unit: "percent" },
				status: "exhausted",
			},
		);
		const output = await renderLiveReports([claude, codex]);
		expect(output).toMatch(/Anthropic · Fable weekly avg[^\n]*85%/);
		expect(output).toMatch(/Openai · Weekly avg[^\n]*75%/);
		expect(output).toMatch(/claude@example\.test:[^\n]*85%[^\n]*resets 2d[^\n]*full resets —/);
		expect(output).toMatch(/codex@example\.test:[^\n]*75%[^\n]*resets 1d[^\n]*full resets —/);
		for (const unrelated of ["Shared weekly", "Sonnet weekly", "Session", "Spark", "100%", "10%", "1 exhausted"])
			expect(output).not.toContain(unrelated);
	});

	it("accepts primary Codex weekly by normalized window, scope window, or duration", async () => {
		for (const metadata of [
			{ window: { id: "7d", label: "7d", durationMs: 604_740_000 } },
			{ window: undefined, scope: { provider: "openai-codex", windowId: "7d" } },
			{ window: { id: "week", label: "week", durationMs: 604_800_000 }, scope: { provider: "openai-codex" } },
		]) {
			const report = accountReport("openai-codex", "primary@example.test", 0.4);
			report.limits[0] = {
				...report.limits[0],
				id: "openai-codex:primary",
				scope: { provider: "openai-codex" },
				...metadata,
			};
			const output = await renderLiveReports([report]);
			expect(output).toMatch(/Openai · Weekly avg[^\n]*40%/);
			expect(output).toMatch(/primary@example\.test:[^\n]*40%/);
		}
	});

	it("keeps missing selected weekly quotas unknown instead of falling back to other windows", async () => {
		const claude = accountReport("anthropic", "claude@example.test", 1);
		claude.limits[0] = {
			...claude.limits[0],
			id: "anthropic:7d",
			scope: { provider: "anthropic", windowId: "7d", shared: true },
		};
		const codex = accountReport("openai-codex", "codex@example.test", 1);
		codex.limits[0] = {
			...codex.limits[0],
			id: "openai-codex:spark:secondary",
			scope: { provider: "openai-codex", windowId: "7d", shared: true },
		};
		const sessionOnly = accountReport("openai-codex", "session@example.test", 1);
		sessionOnly.limits[0] = {
			...sessionOnly.limits[0],
			id: "openai-codex:primary",
			scope: { provider: "openai-codex", windowId: "5h", shared: true },
			window: { id: "5h", label: "5h", durationMs: 18_000_000, resetsAt: now + 60_000 },
		};
		const output = await renderLiveReports([claude, codex, sessionOnly]);
		for (const email of ["claude", "codex", "session"])
			expect(output).toMatch(
				new RegExp(`${email}@example\\.test:[^\\n]*[·░]+[^\\n]*—[^\\n]*resets —[^\\n]*full resets —`),
			);
		expect(output).not.toContain("0%");
		expect(output).not.toContain("1 exhausted");
	});

	it("renders Cursor request quotas in the /usage view", async () => {
		const resetAt = now + 90_000_000;
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: resetAt },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		const output = await renderLiveReports(reports);
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("30% used");
		expect(output).toContain("resets 1d");
	});

	it("shows banked full reset counts including zero, without inventing absent or invalid counts", async () => {
		for (const count of [2, 0, undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const report = accountReport("openai-codex", "user@example.test");
			if (count !== undefined)
				report.resetCredits = {
					availableCount: count,
					credits: [{ expiresAt: new Date(now + 86_400_000).toISOString() }],
				};
			const output = await renderLiveReports([report]);
			expect(output).toContain(`full resets ${count === 2 || count === 0 ? count : "—"}`);
			expect(output).not.toContain("saved");
			expect(output).not.toContain("expires");
		}
		const output = await renderLiveReports([accountReport("anthropic", "claude@example.test")]);
		expect(output).toContain("full resets —");
	});

	it("shows email only without organization suffixes, account notes, or invented email", async () => {
		for (const provider of ["anthropic", "openai-codex"]) {
			const team = accountReport(provider, "user@example.test");
			team.metadata = { ...team.metadata, orgId: "team", orgName: "Team subscription" };
			team.notes = ["Usage unavailable for this organization"];
			team.limits[0].notes = ["Limit-level account note"];
			const personal = accountReport(provider, "user@example.test");
			personal.metadata = { ...personal.metadata, orgId: "personal", orgName: "Personal subscription" };
			const missingEmail = accountReport(provider, "unused@example.test");
			missingEmail.metadata = { orgName: "No email organization" };
			const output = await renderLiveReports([team, personal, missingEmail]);
			expect(output.split("\n").filter(row => row.includes("user@example.test:"))).toHaveLength(2);
			expect(output).toContain("email unavailable");
			for (const hidden of [
				"Team subscription",
				"Personal subscription",
				"No email organization",
				"Usage unavailable for this organization",
				"Limit-level account note",
				"unused@example.test",
			])
				expect(output).not.toContain(hidden);
		}
	});

	it("averages selected weekly usage equally across every account, including hidden rows", async () => {
		const reports = [
			...Array.from({ length: 8 }, (_, i) => accountReport("anthropic", `claude-${i}@example.test`, i < 4 ? 0 : 1)),
			...Array.from({ length: 8 }, (_, i) =>
				accountReport("openai-codex", `codex-${i}@example.test`, i < 4 ? 0 : 1),
			),
		];
		for (const ordered of [reports, reports.toReversed()]) {
			const rows = (await renderLiveReports(ordered, { width: 120, height: 10 })).split("\n");
			expect(rows).toHaveLength(6);
			for (const provider of ["Anthropic", "Openai"]) {
				const header = rows.find(row => row.includes(provider));
				expect(header).toContain("50%");
				expect(header).toContain("8 accounts");
				expect(header).toContain("4 exhausted");
			}
			const accounts = rows.filter(row => row.includes("@example.test"));
			expect(accounts).toHaveLength(3);
			for (const row of accounts) expect(row).toContain("100%");
		}
	});

	it("excludes unknown fractions from the equal-account mean and reports known coverage", async () => {
		for (const provider of ["anthropic", "openai-codex"]) {
			const small = accountReport(provider, "small@example.test", 0.2);
			small.limits[0].amount = { used: 1, limit: 5, unit: "requests" };
			const large = accountReport(provider, "large@example.test", 0.8);
			large.limits[0].amount = { used: 800, limit: 1_000, unit: "requests" };
			const unknown = accountReport(provider, "unknown@example.test");
			unknown.limits[0].amount = { unit: "percent" };
			const rows = (await renderLiveReports([small, large, unknown])).split("\n");
			expect(rows[0]).toMatch(/weekly avg[^\n]*50% \(2\/3 known\)/i);
			expect(rows.find(row => row.includes("unknown@example.test:"))).not.toContain("0%");
			for (const report of [small, large, unknown]) report.limits[0].amount = { unit: "percent" };
			const allUnknown = await renderLiveReports([small, large, unknown]);
			expect(allUnknown.split("\n")[0]).toMatch(/weekly avg[^\n]*·{2,}[^\n]*— \(0\/3 known\)/i);
			expect(allUnknown).not.toContain("0%");
		}
	});

	it("preserves provider headlines while slightly dimming green and red account fills", async () => {
		const originalTheme = theme;
		try {
			for (const name of ["dark", "titanium", "light"]) {
				const selectedTheme = await getThemeByName(name);
				if (!selectedTheme) throw new Error(`Expected ${name} theme`);
				setThemeInstance(selectedTheme);
				expect(theme.fg("customMessageLabel", "headline")).not.toBe(theme.fg("accent", "headline"));
				for (const provider of ["anthropic", "openai-codex"]) {
					const headlineColor = provider === "anthropic" ? "customMessageLabel" : "accent";
					const label = provider === "anthropic" ? "Anthropic · Fable weekly avg" : "Openai · Weekly avg";
					for (const fraction of [0, 0.5, 1]) {
						const raw = await renderLiveReports([accountReport(provider, "bar@example.test", fraction)], {
							raw: true,
						});
						const rows = raw.split("\n");
						const header = rows[0];
						const account = rows.find(row => row.includes("bar@example.test:"))!;
						const headerBar = stripVTControlCharacters(header).match(/[█▓▒░·]{2,}/)?.[0];
						const accountBar = stripVTControlCharacters(account).match(/[█▓▒░·]{2,}/)?.[0];
						expect(headerBar).toBeDefined();
						expect(accountBar).toBeDefined();
						expect(header).toContain(theme.fg(headlineColor, label));
						expect(header).toContain(theme.fg(headlineColor, ` ${fraction * 100}%`));
						const details = stripVTControlCharacters(header).match(/ · 1 accounts.*/)?.[0];
						expect(details).toBeDefined();
						expect(header).toContain(theme.fg(headlineColor, details!));
						for (const segment of headerBar!.match(/[█▓▒]+|░+|·+/g)!)
							expect(header).toContain(theme.fg(headlineColor, segment));
						const filled = accountBar!.match(/[█▓▒]+/)?.[0];
						if (filled) {
							const accountColor = fraction === 1 ? "error" : "success";
							const rgb = Bun.color(theme.getColorHex(accountColor), "[rgb]")!;
							const softened = Bun.color(
								`rgb(${rgb.map(channel => Math.round(channel * 0.88)).join(",")})`,
								theme.getColorMode() === "truecolor" ? "ansi-16m" : "ansi-256",
							);
							expect(softened).not.toBeNull();
							expect(account).toContain(`${softened}${filled}\x1b[39m`);
							// A subtle adjustment can quantize to the same 256-color palette entry.
							if (theme.getColorMode() === "truecolor")
								expect(account).not.toContain(theme.fg(accountColor, filled));
							expect(account).not.toContain(theme.fg(headlineColor, filled));
						} else {
							expect(accountBar).toMatch(/^░+$/);
							expect(account).toContain(theme.fg("dim", accountBar!));
							expect(theme.fg("dim", accountBar!)).not.toBe(theme.fg(headlineColor, accountBar!));
						}
						const empty = accountBar!.match(/░+/)?.[0];
						if (empty) expect(account).toContain(theme.fg("dim", empty));
						if (fraction === 1) expect(accountBar).toMatch(/^█+$/);
						expect(stripVTControlCharacters(header)).toContain(`${fraction * 100}%`);
						expect(stripVTControlCharacters(account)).toContain(`${fraction * 100}% · resets 1h · full resets —`);
					}
				}
				const warning = accountReport("anthropic", "warning@example.test", 0.5);
				warning.limits[0].status = "warning";
				const warningRow = (await renderLiveReports([warning], { raw: true })).split("\n")[1];
				const warningFill = stripVTControlCharacters(warningRow).match(/[█▓▒]+/)![0];
				expect(warningRow).toContain(theme.fg("warning", warningFill));
			}
		} finally {
			setThemeInstance(originalTheme);
		}
	});

	it("budgets one row per account across widths and heights, with exact per-provider omissions", async () => {
		const reports = [
			...Array.from({ length: 8 }, (_, i) => accountReport("openai-codex", `codex-${i}@example.test`)),
			...Array.from({ length: 5 }, (_, i) => accountReport("anthropic", `claude-${i}@example.test`)),
		];
		for (const width of [80, 120]) {
			for (const height of [24, 40, 60]) {
				for (const ordered of [reports, reports.toReversed()]) {
					const output = await renderLiveReports(ordered, { width, height });
					const rows = output.split("\n");
					const visibleCodex = height === 24 ? 3 : 8;
					const visibleClaude = height === 24 ? 3 : 5;
					expect(rows.length).toBeLessThanOrEqual(Math.max(6, Math.floor(height * 0.4)));
					expect(rows).toHaveLength(visibleCodex + visibleClaude + 3);
					expect(rows.filter(row => /codex-\d@example\.test/.test(row))).toHaveLength(visibleCodex);
					expect(rows.filter(row => /claude-\d@example\.test/.test(row))).toHaveLength(visibleClaude);
					const codex = rows.find(row => row.includes("Openai"));
					const claude = rows.find(row => row.includes("Anthropic"));
					if (width === 120) expect(codex).toContain("8 accounts");
					expect(codex).toContain(`${8 - visibleCodex} omitted`);
					if (width === 120) expect(claude).toContain("5 accounts");
					expect(claude).toContain(`${5 - visibleClaude} omitted`);
				}
			}
		}
	});

	it("redistributes unused detail rows without starving a small provider in either report order", async () => {
		for (const [codexCount, claudeCount] of [
			[10, 1],
			[1, 10],
		]) {
			const reports = [
				...Array.from({ length: codexCount }, (_, i) => accountReport("openai-codex", `codex-${i}@example.test`)),
				...Array.from({ length: claudeCount }, (_, i) => accountReport("anthropic", `claude-${i}@example.test`)),
			];
			for (const ordered of [reports, reports.toReversed()]) {
				const rows = (await renderLiveReports(ordered, { width: 80, height: 24 })).split("\n");
				expect(rows).toHaveLength(9);
				for (const [label, prefix, total] of [
					["Openai", "codex-", codexCount],
					["Anthropic", "claude-", claudeCount],
				] as const) {
					const visible = total === 1 ? 1 : 5;
					expect(rows.filter(row => row.includes(prefix))).toHaveLength(visible);
					const header = rows.find(row => row.includes(label));
					expect(header).toContain(`${total - visible} omitted`);
				}
			}
		}
	});

	it("prioritizes selected weekly pressure rather than exhausted unrelated windows", async () => {
		for (const provider of ["anthropic", "openai-codex"]) {
			const decoy = accountReport(provider, "decoy@example.test", 0.01);
			decoy.limits.unshift({
				...decoy.limits[0],
				id: provider === "anthropic" ? "anthropic:7d:sonnet" : "openai-codex:spark:secondary",
				scope: { provider, windowId: "7d", shared: true, tier: "sonnet" },
				amount: { usedFraction: 1, unit: "percent" },
				status: "exhausted",
			});
			const reports = [
				decoy,
				...Array.from({ length: 5 }, (_, i) => accountReport(provider, `priority-${i}@example.test`, 0.9)),
			];
			const rows = (await renderLiveReports(reports, { height: 10 })).split("\n");
			expect(rows).toHaveLength(6);
			expect(rows[0]).toContain("0 exhausted");
			expect(rows[0]).toContain("2 omitted");
			expect(rows.filter(row => row.includes("priority-"))).toHaveLength(4);
			expect(rows.join("\n")).not.toContain("decoy@example.test");
		}
	});

	it("counts hidden exhaustion, favors actionable and active accounts, and dates the oldest cached report", async () => {
		const stale = accountReport("anthropic", "stale@example.test", 0.01);
		stale.fetchedAt = now - 120_000;
		const reports = [
			stale,
			accountReport("anthropic", "low@example.test", 0.1),
			accountReport("anthropic", "medium@example.test", 0.5),
			accountReport("anthropic", "high@example.test", 0.95),
			accountReport("anthropic", "active@example.test", 0.02),
			...Array.from({ length: 3 }, (_, i) => accountReport("anthropic", `exhausted-${i}@example.test`, 1)),
			accountReport("openai-codex", "codex@example.test"),
		];
		// Explicit provider exhaustion must take precedence even without an amount.
		reports[5].limits[0].amount = { unit: "percent" };
		for (const height of [10, 24]) {
			const output = await renderLiveReports(reports, { height, activeAccount: { email: "active@example.test" } });
			const rows = output.split("\n");
			const header = rows.find(row => row.includes("Anthropic"));
			expect(header).toContain("8 accounts");
			expect(header).toContain("3 exhausted");
			expect(header).toContain(height === 10 ? "6 omitted" : "3 omitted");
			expect(header).toContain("oldest 2m ago");
			expect(rows.find(row => row.includes("Openai"))).toContain("oldest 5.0s ago");
			expect(rows.filter(row => /exhausted-\d@example\.test/.test(row))).toHaveLength(height === 10 ? 2 : 3);
			expect(output).not.toContain("stale@example.test");
			expect(output).not.toContain("low@example.test");
			expect(output).not.toContain("medium@example.test");
			if (height === 24) {
				expect(rows.find(row => row.includes("active@example.test"))).toContain("active@example.test:");
				expect(output).toContain("high@example.test");
			} else {
				expect(output).not.toContain("active@example.test");
			}
		}
	});

	it("keeps every provider header and controls when their minimum exceeds the soft height cap", async () => {
		const providers = ["anthropic", "openai-codex", "cursor", "google", "github-copilot", "openrouter"];
		const reports = providers.map(provider => accountReport(provider, `${provider}@example.test`));
		const rows = (await renderLiveReports(reports, { width: 80, height: 10 })).split("\n");
		expect(rows).toHaveLength(7);
		for (const label of ["Anthropic", "Openai", "Cursor", "Google", "Github Copilot", "Openrouter"]) {
			const header = rows.find(row => row.includes(label));
			if (label !== "Anthropic" && label !== "Openai") expect(header).toContain("1 account");
			expect(header).toContain("1 omitted");
		}
	});
});
