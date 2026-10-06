import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, type UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController, renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { colorToAnsi } from "@oh-my-pi/pi-tui/theme/color";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

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
	it("shows the current Codex plan in interactive account and reset rows without a single-account UUID", () => {
		const now = Date.now();
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: now,
			limits: [
				{
					id: "codex-weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", accountId: "workspace-id" },
					amount: { usedFraction: 0.25, unit: "percent" },
				},
			],
			metadata: {
				email: "user@example.test",
				accountId: "workspace-id",
				orgId: "workspace-id",
				orgName: "free",
				planType: "prolite",
			},
			resetCredits: { availableCount: 1 },
		};
		const output = stripVTControlCharacters(
			renderUsageReports([report], theme, now, 98, () => ({
				email: "user@example.test",
				accountId: "workspace-id",
				orgId: "workspace-id",
				orgName: "free",
			})),
		);
		expect(output).toContain("in use by this session: user@example.test (prolite)");
		expect(output).toContain("user@example.test (prolite): 1 saved reset");
		expect(output).toMatch(/^  ● user@example\.test \(prolite\)/m);
		expect(output).not.toContain("workspace-id");
		expect(output).not.toContain("(free)");
	});

	it("distinguishes same-email Codex accounts even if one has no current plan or limits", () => {
		const now = Date.now();
		const reports: UsageReport[] = ["workspace-one", "workspace-two"].map((orgId, index) => ({
			provider: "openai-codex",
			fetchedAt: now,
			limits: [],
			metadata: {
				email: "shared@example.test",
				orgId,
				orgName: "free",
				...(index === 0 ? { planType: "prolite" } : {}),
			},
		}));
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("shared@example.test (workspace-one) (prolite) -- no limits");
		expect(output).toContain("shared@example.test (workspace-two) -- no limits");
		expect(output).not.toContain("(free)");
	});

	it("keeps colliding Codex accounts distinct in quota columns", () => {
		const reports: UsageReport[] = ["workspace-one", "workspace-two"].map(orgId => ({
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", accountId: orgId },
					amount: { usedFraction: 0.25, unit: "percent" },
				},
			],
			metadata: { email: "shared@example.test", orgId, orgName: "free", planType: "prolite" },
		}));
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		expect(output).toMatch(
			/^  shared@example\.test \(workspace-one\) \(prolite\) +shared@example\.test \(workspace-two\) \(prolite\)$/m,
		);
		expect(output).not.toContain("(free)");
	});
	it("marks the matching legacy Codex workspace active when accounts share an email", () => {
		const reports: UsageReport[] = ["workspace-one", "workspace-two"].map(accountId => ({
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "shared@example.test", accountId, orgName: "free" },
			resetCredits: { availableCount: 1 },
		}));
		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, () => ({
				email: "shared@example.test",
				accountId: "workspace-two",
			})),
		);
		expect(output).toContain("in use by this session: shared@example.test (workspace-two)");
		expect(output).toContain("shared@example.test (workspace-two): 1 saved reset (active)");
		expect(output).toContain("shared@example.test (workspace-one): 1 saved reset\n");
	});

	it("keeps unavailable status visible beside a long account label in a narrow terminal", () => {
		const width = 40;
		const output = stripVTControlCharacters(
			renderUsageReports(
				[],
				theme,
				1_790_424_000_000,
				width,
				undefined,
				[],
				[{ provider: "anthropic", label: `alex · ${"界".repeat(80)}` }],
			),
		);

		expect(output).toMatch(/alex.*usage unavailable/);
		for (const line of output.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps control characters in unavailable account labels from changing terminal layout", () => {
		const rendered = renderUsageReports(
			[],
			theme,
			1_790_424_000_000,
			80,
			undefined,
			[],
			[{ provider: "anthropic", label: "\x1b[2Jalex\r\n\tteam" }],
		);
		const output = stripVTControlCharacters(rendered);

		expect(output).toMatch(/alex +team.*usage unavailable/);
		expect(rendered).not.toContain("\x1b[2J");
		expect(output).not.toContain("\r");
		expect(output).not.toContain("\t");
	});
});

describe("interactive /usage account visibility", () => {
	const now = 1_790_424_000_000;
	const email = "shared@example.test";
	const sessionId = "usage-visibility-test";
	let authStorage: AuthStorage;
	let mounted: UsageDashboardComponent | undefined;
	let terminalRows: PropertyDescriptor | undefined;

	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	beforeEach(async () => {
		terminalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
		vi.spyOn(Date, "now").mockReturnValue(now);
		vi.spyOn(activityClient, "loadDailyActivity").mockImplementation(async push => {
			push([]);
		});
		authStorage = await AuthStorage.create(":memory:");
		await authStorage.credentials.set(
			"anthropic",
			["org-team", "org-personal"].map(orgId => ({
				type: "oauth" as const,
				access: `test-access-${orgId}`,
				refresh: `test-refresh-${orgId}`,
				expires: now + 3_600_000,
				email,
				accountId: "shared-account",
				orgId,
			})),
		);
		await authStorage.credentials.set("tavily", { type: "api_key", key: "test-key" });
		const personal = authStorage.oauth.accounts("anthropic").find(account => account.orgId === "org-personal");
		if (!personal || !authStorage.sessions.pin("anthropic", sessionId, personal.credentialId)) {
			throw new Error("Expected the personal account to be selectable");
		}
	});

	afterEach(() => {
		mounted?.dispose();
		mounted = undefined;
		authStorage?.close();
		if (terminalRows) Object.defineProperty(process.stdout, "rows", terminalRows);
		else Reflect.deleteProperty(process.stdout, "rows");
		vi.restoreAllMocks();
	});

	function command(
		fetchUsageReports?: () => Promise<UsageReport[] | null>,
		warnings: string[] = [],
	): CommandController {
		const ctx = createInteractiveModeContext({
			session: {
				sessionId,
				model: { provider: "anthropic" },
				modelRegistry: { authStorage },
				fetchUsageReports,
				getUsageReportingModelSelectors: () => [],
			},
			ui: {
				showOverlay: component => {
					if (!(component instanceof UsageDashboardComponent)) throw new Error("Expected usage dashboard");
					mounted = component;
					return {
						hide: () => {
							mounted = undefined;
						},
						setHidden: () => {},
						isHidden: () => false,
					};
				},
			},
			showWarning: message => {
				warnings.push(message);
			},
		});
		const selector = new SelectorController(ctx);
		ctx.showUsageDashboard = reports => selector.showUsageDashboard(reports);
		return new CommandController(ctx);
	}

	function display(): string {
		return stripVTControlCharacters(mounted?.render(120).join("\n") ?? "");
	}

	it("warns without opening the dashboard when usage reporting is not configured", async () => {
		const warnings: string[] = [];
		await command(undefined, warnings).handleUsageCommand();

		expect(warnings).toEqual([expect.stringContaining("not configured")]);
		expect(mounted).toBeUndefined();
	});

	it("keeps a missing Claude subscription visible beside its same-email sibling's real usage", async () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			metadata: { email, accountId: "shared-account", orgId: "org-team" },
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", accountId: "shared-account", orgId: "org-team", windowId: "5h" },
					window: { id: "5h", label: "5 Hour", resetsAt: now + 3_600_000 },
					amount: { usedFraction: 0.25, unit: "percent" },
					status: "ok",
				},
			],
			resetCredits: { availableCount: 2, redeemableCount: 1 },
		};
		await command(async () => [report]).handleUsageCommand();

		const overview = display();
		expect(overview).toContain("2 accts");
		expect(overview).toContain(email);
		expect(overview).toContain("org-personal");
		expect(overview).toContain("usage unavailable");
		expect(overview).toContain("75%");
		expect(overview).not.toContain("Tavily");

		mounted?.handleInput("\r");
		const details = display();
		expect(details).toMatch(/shared@example\.test.*org-personal.*usage unavailable/);
		expect(details).toContain("shared@example.test (org-team)");
		expect(details).toContain("75% free");
		expect(details).toContain("2 saved resets");
		expect(details).toContain("1 usable now");
		expect(details).toContain("in use by this session: shared@example.test (org-personal)");
		expect(details).not.toMatch(/org-team.*usage unavailable/);
	});

	it.each(["empty", "null", "error"] as const)(
		"opens both stored Claude subscriptions with unknown usage when lookup returns %s",
		async result => {
			await command(async () => {
				if (result === "error") throw new Error("usage endpoint unavailable");
				return result === "null" ? null : [];
			}).handleUsageCommand();

			const overview = display();
			expect(overview).toContain("2 accts");
			expect(overview.match(/shared@example\.test/g)).toHaveLength(2);
			expect(overview).toContain("org-team");
			expect(overview).toContain("org-personal");
			expect(overview.match(/usage unavailable/g)).toHaveLength(2);
			expect(overview).not.toContain("%");
			expect(overview).not.toContain("untouched");
			expect(overview).not.toContain("no limits");
			expect(overview).not.toContain("Tavily");

			mounted?.handleInput("\r");
			const details = display();
			expect(details).toMatch(/shared@example\.test.*org-team.*usage unavailable/);
			expect(details).toMatch(/shared@example\.test.*org-personal.*usage unavailable/);
			expect(details).toContain("in use by this session: shared@example.test (org-personal)");
			expect(details).not.toContain("%");
			expect(details).not.toContain("Infinity");

			mounted?.handleInput("\x1b");
			expect(display()).toContain("2 accts");
			mounted?.handleInput("\x1b");
			expect(mounted).toBeUndefined();
		},
	);
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
			window: { id: windowId, label: windowId === "chat:secondary" ? "Weekly" : windowId },
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

	/** `  <label padded>  <16 bar cells>  <NN% left padded to 9>`; the bar glyphs depend on rounding, the readout does not. */
	function windowRow(label: string, labelWidth: number, left: string): RegExp {
		const readout = left.padStart(9).replace(/[%]/g, "\\%");
		return new RegExp(`^  ${label.padEnd(labelWidth).replace(/ /g, " ")}  [█▓▒░]{16}  ${readout}$`);
	}

	it("renders one pool headline per provider from aggregate OpenAI capacity, no account rows", async () => {
		const rows = await renderPinnedSnapshot([
			pooledReport("openai-codex", "codex-a", { "chat:secondary": 1 }),
			pooledReport("openai-codex", "codex-b", { "chat:secondary": 1 }),
			pooledReport("anthropic", "claude-a", { "5h": 0.1, "7d": 0.3, "7d:fable": 0.6 }),
			pooledReport("anthropic", "claude-b", { "5h": 0.5, "7d": 0.9, "7d:fable": 0.2 }),
		]);
		expect(rows).toHaveLength(8);
		expect(rows[0]).toBe("Anthropic");
		// Each dashboard window is averaged independently: Fable uses only 7d:fable.
		expect(rows[1]).toMatch(windowRow("Fable Weekly", 12, "60% left"));
		expect(rows[2]).toMatch(windowRow("Weekly", 12, "40% left"));
		expect(rows[3]).toMatch(windowRow("Five Hour", 12, "70% left"));
		expect(rows[4]).toBe("");
		expect(rows[5]).toBe("OpenAI");
		expect(rows[6]).toMatch(windowRow("Weekly", 12, "0% left"));
		expect(rows.join("\n")).not.toContain("codex-a");
		expect(rows.join("\n")).not.toContain("claude-a");
	});

	it("renders no OpenAI five-hour row", async () => {
		const rows = await renderPinnedSnapshot([pooledReport("openai-codex", "codex-a", { "chat:secondary": 0.75 })]);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toBe("OpenAI");
		expect(rows[1]).toMatch(windowRow("Weekly", 6, "25% left"));
		expect(rows[2]).toContain("Usage snapshot · fetched ");
	});

	it("renders dotted missing windows for an Anthropic report", async () => {
		const rows = await renderPinnedSnapshot([pooledReport("anthropic", "claude-a", { "7d": 0.25 })]);
		expect(rows[0]).toBe("Anthropic");
		expect(rows[1]).toMatch(/^  Fable Weekly +·{16} +—$/);
		expect(rows[2]).toMatch(/^  Weekly +[█▓▒░]{16} +75% left$/);
		expect(rows[3]).toMatch(/^  Five Hour +·{16} +—$/);
		expect(rows[1].indexOf("·")).toBe(rows[2].indexOf("█"));
		expect(rows[3].indexOf("·")).toBe(rows[2].indexOf("█"));
	});

	it("colors headings by provider brand and weekly bars by headroom", async () => {
		const [heading, weekly] = await renderPinnedSnapshot(
			[pooledReport("openai-codex", "codex-a", { "chat:secondary": 0.5 })],
			{ raw: true },
		);
		// OpenAI brand green heading; 50% left uses the success fill.
		expect(heading).toContain(colorToAnsi("#10a37f", theme.getColorMode()));
		expect(weekly).toContain(theme.fg("success", "████████"));
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
			/^fetched \d\d:\d\d · \/usage to hide$/,
		);
		expect((await renderPinnedSnapshot(reports, { width: 14 })).at(-1)).toBe("/usage");
	});
});
