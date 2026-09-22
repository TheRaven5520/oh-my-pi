import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController, renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
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

/** One Sprilicred pooled account reporting the given windows as used fractions. */
function pooledReport(provider: string, account: string, windows: Record<string, number>): UsageReport {
	return {
		provider,
		fetchedAt: now - 5_000,
		metadata: { sprilicredAccountId: account },
		limits: Object.entries(windows).map(([windowId, usedFraction]) => ({
			id: windowId,
			label: windowId,
			scope: { provider, windowId },
			window: { id: windowId, label: windowId },
			amount: { usedFraction, unit: "percent" as const },
			status: usedFraction >= 1 ? ("exhausted" as const) : ("ok" as const),
		})),
	};
}

async function renderPinnedSnapshot(
	reports: UsageReport[] | null,
	{ width = 120, raw = false }: { width?: number; raw?: boolean } = {},
): Promise<readonly string[]> {
	const usageContainer = new Container();
	const fetchUsageReports = vi.fn(async () => reports);
	const ctx = {
		session: { sessionId: "usage-formatting-test", fetchUsageReports },
		ui: { terminal: { columns: width, rows: 40 }, requestRender: vi.fn() },
		usageContainer,
	} as unknown as InteractiveModeContext;
	const controller = new CommandController(ctx);
	try {
		controller.setUsagePinned(true);
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		expect(usageContainer.children).toHaveLength(1);
		const rendered = usageContainer.render(width);
		const rows = rendered.map(stripVTControlCharacters);
		expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
		return raw ? rendered : rows;
	} finally {
		controller.setUsagePinned(false);
		expect(usageContainer.children).toHaveLength(0);
	}
}

describe("CommandController pinned /usage snapshot", () => {
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

	it("renders one pool headline per provider from the best-headroom account, no account rows", async () => {
		const rows = await renderPinnedSnapshot([
			pooledReport("openai-codex", "codex-a", { "chat:primary": 1, "chat:secondary": 1 }),
			pooledReport("openai-codex", "codex-b", { "chat:primary": 0.04, "chat:secondary": 1 }),
			pooledReport("anthropic", "claude-a", { "5h": 0.1, "7d": 0.3, "7d:fable": 0.6 }),
			pooledReport("anthropic", "claude-b", { "5h": 0.5, "7d": 0.9, "7d:fable": 0.2 }),
		]);
		const fetched = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
		expect(rows).toEqual([
			"Anthropic",
			"  - Fable Weekly [xxxxxx----]",
			"  - Weekly       [xxx-------]",
			"  - Five Hour    [x---------]",
			"",
			"OpenAI",
			"  - Weekly       [xxxxxxxxxx]",
			"  - Five Hour    [----------]",
			`Usage snapshot · fetched ${fetched.format(now)} · /usage clear`,
		]);
		expect(rows.join("\n")).not.toContain("codex-a");
		expect(rows.join("\n")).not.toContain("claude-a");
	});

	it("renders an unreported window as an empty dimmed bar with a dash and pads labels to the widest", async () => {
		const rows = await renderPinnedSnapshot([pooledReport("openai-codex", "codex-a", { "chat:secondary": 0.75 })]);
		expect(rows).toEqual([
			"OpenAI",
			"  - Weekly    [xxxxxxxx--]",
			"  - Five Hour [----------] —",
			expect.stringContaining("Usage snapshot · fetched "),
		]);
	});

	it("colors bar cells plainly: x in text, brackets and dashes muted", async () => {
		const [, weekly] = await renderPinnedSnapshot(
			[pooledReport("openai-codex", "codex-a", { "chat:secondary": 0.5, "chat:primary": 0 })],
			{ raw: true },
		);
		expect(weekly).toContain(theme.fg("muted", "[") + theme.fg("text", "xxxxx") + theme.fg("muted", "-----]"));
		expect(weekly).not.toContain(theme.fg("warning", "x"));
	});

	it("capitalizes other providers and orders Anthropic, OpenAI, then the rest", async () => {
		const rows = await renderPinnedSnapshot([
			pooledReport("cursor", "cursor-a", { "7d": 0.5 }),
			pooledReport("openai-codex", "codex-a", { "chat:secondary": 0.1 }),
			pooledReport("anthropic", "claude-a", { "7d": 0.1 }),
		]);
		expect(rows.filter(row => !row.startsWith(" ") && row !== "")).toEqual([
			"Anthropic",
			"OpenAI",
			"Cursor",
			expect.stringContaining("Usage snapshot"),
		]);
	});

	it("ignores non-pooled reports and reports null/empty results as no pooled data", async () => {
		const personal: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			metadata: { email: "me@example.test" },
			limits: [
				{
					id: "7d",
					label: "Weekly",
					scope: { provider: "anthropic", windowId: "7d" },
					amount: { usedFraction: 0.5, unit: "percent" },
					status: "ok",
				},
			],
		};
		for (const reports of [[personal], [], null]) {
			const rows = await renderPinnedSnapshot(reports);
			expect(rows).toEqual(["No pooled usage data.", expect.stringContaining("Usage snapshot · fetched ")]);
			expect(rows.join("\n")).not.toContain("me@example.test");
		}
	});

	it("shortens the footer before clipping it on narrow terminals", async () => {
		const reports = [pooledReport("openai-codex", "codex-a", { "chat:secondary": 0.1 })];
		expect((await renderPinnedSnapshot(reports, { width: 30 })).at(-1)).toMatch(
			/^fetched \d\d:\d\d · \/usage clear$/,
		);
		expect((await renderPinnedSnapshot(reports, { width: 14 })).at(-1)).toBe("/usage clear");
	});
});
