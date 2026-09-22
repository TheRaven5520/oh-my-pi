import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	BUILTIN_SLASH_COMMANDS,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

const fetchedAt = 1_700_000_000_000;
function reports(email: string): UsageReport[] {
	return [
		{
			provider: "openai-codex",
			fetchedAt,
			metadata: { email },
			limits: [
				{
					id: "openai-codex:secondary",
					label: "Weekly",
					scope: { provider: "openai-codex", windowId: "7d", shared: true },
					window: { id: "7d", label: "7d", durationMs: 604_740_000, resetsAt: fetchedAt + 86_400_000 },
					amount: { usedFraction: 0.2, unit: "percent" },
					status: "ok",
				},
			],
		},
	];
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

let mode: InteractiveMode;
let tempDir: TempDir;
let fetchUsageReports: ReturnType<typeof vi.fn<() => Promise<UsageReport[] | null>>>;
let now: number;

function panel(): string {
	return stripVTControlCharacters(mode.liveUsageContainer.render(120).join("\n"));
}

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-live-usage-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	fetchUsageReports = vi.fn(async () => reports("first@example.test"));
	const session = {
		sessionManager,
		sessionId: sessionManager.getSessionId(),
		settings,
		agent: { state: { tools: [] }, metadataForProvider: () => undefined },
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
		isStreaming: true,
		fetchUsageReports,
		getUsageReportingModelSelectors: () => [],
	} as unknown as AgentSession;
	mode = new InteractiveMode(session, "test");
	vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
	vi.useFakeTimers();
	now = fetchedAt + 5_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
	mode?.stop();
	vi.useRealTimers();
	vi.restoreAllMocks();
	tempDir?.removeSync();
	resetSettingsForTest();
});

describe("/usage live panel", () => {
	it("dispatches plain usage immediately, stays pinned during streaming, and replaces rather than accumulates reports", async () => {
		const pending = Promise.withResolvers<UsageReport[] | null>();
		fetchUsageReports.mockImplementationOnce(() => pending.promise);
		expect(await executeBuiltinSlashCommand("/usage", { ctx: mode })).toBe(true);
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		expect(panel()).toContain("Fetching usage data");
		expect(panel()).toContain("Live usage");
		expect(panel()).toContain("/usage off");
		pending.resolve(reports("first@example.test"));
		await flushMicrotasks();
		expect(panel()).toContain("first@example.test");
		const initial = panel();
		now += 9_000;
		expect(panel()).not.toBe(initial);
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		fetchUsageReports.mockResolvedValue(reports("updated@example.test"));
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(panel()).toContain("updated@example.test");
		expect(panel()).not.toContain("first@example.test");
		expect(mode.liveUsageContainer.children).toHaveLength(1);
		expect(mode.chatContainer.children).toHaveLength(0);
		expect(mode.deferredCommandContainer.children).toHaveLength(0);
	});

	it("makes repeated plain usage and explicit on idempotent and off stops recurring fetches", async () => {
		await executeBuiltinSlashCommand("/usage", { ctx: mode });
		await executeBuiltinSlashCommand("/usage", { ctx: mode });
		await executeBuiltinSlashCommand("/usage on", { ctx: mode });
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		expect(mode.liveUsageContainer.children).toHaveLength(1);
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(fetchUsageReports).toHaveBeenCalledTimes(2);
		await executeBuiltinSlashCommand("/usage off", { ctx: mode });
		expect(panel()).toBe("");
		vi.advanceTimersByTime(90_000);
		await flushMicrotasks();
		expect(fetchUsageReports).toHaveBeenCalledTimes(2);
		expect(mode.chatContainer.children).toHaveLength(0);
	});

	it("does not overlap slow fetches or revive a panel after off", async () => {
		const pending = Promise.withResolvers<UsageReport[] | null>();
		fetchUsageReports.mockImplementation(() => pending.promise);
		mode.setLiveUsageEnabled(true);
		vi.advanceTimersByTime(90_000);
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		mode.setLiveUsageEnabled(false);
		pending.resolve(reports("stale@example.test"));
		await flushMicrotasks();
		expect(panel()).toBe("");
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
	});

	it("waits for an old request when re-enabled and discards its result", async () => {
		const pending = Promise.withResolvers<UsageReport[] | null>();
		fetchUsageReports.mockImplementationOnce(() => pending.promise);
		mode.setLiveUsageEnabled(true);
		mode.setLiveUsageEnabled(false);
		mode.setLiveUsageEnabled(true);
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		pending.resolve(reports("stale@example.test"));
		await flushMicrotasks();
		expect(fetchUsageReports).toHaveBeenCalledTimes(2);
		expect(panel()).toContain("first@example.test");
		expect(panel()).not.toContain("stale@example.test");
	});

	for (const cleanup of ["clearTransientSessionUi", "stop"] as const) {
		it(`cleans up timers and late results on ${cleanup}`, async () => {
			const pending = Promise.withResolvers<UsageReport[] | null>();
			fetchUsageReports.mockImplementation(() => pending.promise);
			mode.setLiveUsageEnabled(true);
			mode[cleanup]();
			expect(panel()).toBe("");
			pending.resolve(reports("stale@example.test"));
			await flushMicrotasks();
			vi.advanceTimersByTime(60_000);
			expect(panel()).toBe("");
			expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		});
	}

	it("keeps live usage through transcript rebuilds and deferred-output settlement", async () => {
		mode.setLiveUsageEnabled(true);
		await flushMicrotasks();
		mode.resetTranscript();
		mode.flushPendingCommandOutput();
		expect(panel()).toContain("first@example.test");
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(fetchUsageReports).toHaveBeenCalledTimes(2);
		expect(mode.liveUsageContainer.children).toHaveLength(1);
	});

	it("drops data from a replaced session even before lifecycle cleanup", async () => {
		const pending = Promise.withResolvers<UsageReport[] | null>();
		fetchUsageReports.mockImplementation(() => pending.promise);
		mode.setLiveUsageEnabled(true);
		Object.defineProperty(mode.session, "sessionId", { value: "replacement-session" });
		pending.resolve(reports("stale@example.test"));
		await flushMicrotasks();
		vi.advanceTimersByTime(60_000);
		expect(panel()).toBe("");
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
	});

	it("retains controls for empty reports and errors, and recovers on the next refresh", async () => {
		fetchUsageReports.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline"));
		mode.setLiveUsageEnabled(true);
		await flushMicrotasks();
		expect(panel()).toContain("No usage data available.");
		expect(panel()).toContain("Live usage");
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(panel()).toContain("offline");
		expect(panel()).toContain("/usage off");
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(panel()).toContain("first@example.test");
		expect(panel()).not.toContain("offline");
	});

	it("shows every Codex and Claude account in the 120x40 pinned panel without clipping either provider", async () => {
		Object.defineProperties(mode.ui.terminal, {
			columns: { configurable: true, value: 120 },
			rows: { configurable: true, value: 40 },
		});
		const usageReports: UsageReport[] = (["openai-codex", "anthropic"] as const).flatMap(provider =>
			Array.from({ length: provider === "openai-codex" ? 8 : 5 }, (_, i) => ({
				provider,
				fetchedAt,
				metadata: { email: `${provider === "anthropic" ? "claude" : "codex"}-${i + 1}@example.test` },
				limits: [
					{
						id: provider === "anthropic" ? "anthropic:7d:fable" : "openai-codex:secondary",
						label: provider === "anthropic" ? "Fable weekly" : "Weekly",
						scope: { provider, windowId: "7d", ...(provider === "anthropic" ? { tier: "fable" } : {}) },
						window: { id: "7d", label: "Weekly", durationMs: 604_740_000, resetsAt: now + 3_600_000 },
						amount: { usedFraction: 0.2, unit: "percent" as const },
						status: "ok" as const,
					},
				],
			})),
		);
		fetchUsageReports.mockResolvedValue(usageReports);
		await executeBuiltinSlashCommand("/usage", { ctx: mode });
		await flushMicrotasks();
		const rows = mode.liveUsageContainer.render(120).map(stripVTControlCharacters);
		expect(rows).toHaveLength(16);
		expect(rows.filter(row => row.includes("Openai · Weekly avg"))).toHaveLength(1);
		expect(rows.filter(row => row.includes("Anthropic"))).toHaveLength(1);
		for (const report of usageReports) {
			expect(rows.filter(row => row.includes(String(report.metadata?.email)))).toHaveLength(1);
		}
		expect(rows.every(row => visibleWidth(row) <= 120)).toBe(true);
		expect(rows.at(-1)).toContain("/usage off");
		expect(rows.at(-1)).toContain("30s");
	});

	it("treats show as an alias of plain usage: pins the panel once and refreshes on the timer", async () => {
		expect(await executeBuiltinSlashCommand("/usage show", { ctx: mode })).toBe(true);
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		await flushMicrotasks();
		expect(panel()).toContain("first@example.test");
		expect(panel()).toContain("/usage off");
		expect(mode.chatContainer.children).toHaveLength(0);
		await executeBuiltinSlashCommand("/usage", { ctx: mode });
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(30_000);
		await flushMicrotasks();
		expect(fetchUsageReports).toHaveBeenCalledTimes(2);
	});

	it("rejects unknown verbs with the current help without touching the panel", async () => {
		const status = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		expect(await executeBuiltinSlashCommand("/usage bogus", { ctx: mode })).toBe(true);
		expect(status).toHaveBeenCalledWith("Usage: /usage [show|on|off|reset [provider/credential-id|provider/active]]");
		expect(fetchUsageReports).not.toHaveBeenCalled();
		expect(panel()).toBe("");
		vi.advanceTimersByTime(60_000);
		expect(fetchUsageReports).not.toHaveBeenCalled();
	});

	it("offers show, on, off, and reset completions", async () => {
		const usage = BUILTIN_SLASH_COMMANDS.find(command => command.name === "usage");
		expect(usage?.getArgumentCompletions).toBeDefined();
		const completions = await usage?.getArgumentCompletions?.("");
		expect(completions?.map(item => item.value.trimEnd())).toEqual(["show", "on", "off", "reset"]);
		expect((await usage?.getArgumentCompletions?.("sh"))?.map(item => item.label)).toEqual(["show"]);
	});

	it("keeps reset on its existing selector path without toggling live usage", async () => {
		const selector = vi.spyOn(mode, "showResetUsageSelector").mockResolvedValue();
		await executeBuiltinSlashCommand("/usage reset", { ctx: mode });
		expect(selector).toHaveBeenCalledTimes(1);
		expect(fetchUsageReports).not.toHaveBeenCalled();
		expect(panel()).toBe("");
	});
});
