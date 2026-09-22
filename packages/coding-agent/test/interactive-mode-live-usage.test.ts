import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
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
import { TempDir } from "@oh-my-pi/pi-utils";

const fetchedAt = 1_700_000_000_000;

/** One pooled Codex account with the given weekly usage. */
function reports(weeklyUsedFraction: number): UsageReport[] {
	return [
		{
			provider: "openai-codex",
			fetchedAt,
			metadata: { sprilicredAccountId: `codex-${weeklyUsedFraction}` },
			limits: [
				{
					id: "chat:secondary",
					label: "Weekly",
					scope: { provider: "openai-codex", windowId: "chat:secondary" },
					window: { id: "7d", label: "7d", durationMs: 604_740_000, resetsAt: fetchedAt + 86_400_000 },
					amount: { usedFraction: weeklyUsedFraction, unit: "percent" },
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
let fetchUsageReports: Mock<() => Promise<UsageReport[] | null>>;

function panel(): string {
	return stripVTControlCharacters(mode.usageContainer.render(120).join("\n"));
}

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-usage-pin-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	fetchUsageReports = vi.fn(async () => reports(0.2));
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
	vi.spyOn(Date, "now").mockImplementation(() => fetchedAt + 5_000);
});

afterEach(() => {
	mode?.stop();
	vi.useRealTimers();
	vi.restoreAllMocks();
	tempDir?.removeSync();
	resetSettingsForTest();
});

describe("/usage pinned snapshot", () => {
	it("pins plain /usage immediately, fetches once, and never refetches on its own", async () => {
		const pending = Promise.withResolvers<UsageReport[] | null>();
		fetchUsageReports.mockImplementationOnce(() => pending.promise);
		expect(await executeBuiltinSlashCommand("/usage", { ctx: mode })).toBe(true);
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		expect(panel()).toContain("Fetching usage data");
		expect(panel()).toContain("Usage snapshot · fetching… · /usage to hide");
		pending.resolve(reports(0.2));
		await flushMicrotasks();
		expect(panel()).toContain("OpenAI");
		expect(panel()).toMatch(/Weekly +[█▓▒░]{16} +80% left/);
		expect(panel()).not.toContain("Five Hour");
		expect(panel()).not.toContain("Fetching usage data");
		vi.advanceTimersByTime(10 * 60_000);
		await flushMicrotasks();
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		expect(mode.usageContainer.children).toHaveLength(1);
		expect(mode.chatContainer.children).toHaveLength(0);
		expect(mode.deferredCommandContainer.children).toHaveLength(0);
	});

	it("toggles plain /usage off and on", async () => {
		expect(await executeBuiltinSlashCommand("/usage", { ctx: mode })).toBe(true);
		await flushMicrotasks();
		expect(panel()).toContain("OpenAI");
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		expect(mode.usageContainer.children).toHaveLength(1);

		expect(await executeBuiltinSlashCommand("/usage", { ctx: mode })).toBe(true);
		expect(panel()).toBe("");
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		expect(mode.usageContainer.children).toHaveLength(0);

		expect(await executeBuiltinSlashCommand("/usage", { ctx: mode })).toBe(true);
		await flushMicrotasks();
		expect(panel()).toContain("OpenAI");
		expect(fetchUsageReports).toHaveBeenCalledTimes(2);
		expect(mode.usageContainer.children).toHaveLength(1);
	});

	it("shows a new snapshot when toggled after a session switch with an old fetch pending", async () => {
		const pending = Promise.withResolvers<UsageReport[] | null>();
		fetchUsageReports.mockImplementationOnce(() => pending.promise);
		await executeBuiltinSlashCommand("/usage", { ctx: mode });
		Object.defineProperty(mode.session, "sessionId", { value: "replacement-session" });
		await executeBuiltinSlashCommand("/usage", { ctx: mode });
		await flushMicrotasks();
		expect(panel()).toContain("80% left");
		expect(fetchUsageReports).toHaveBeenCalledTimes(2);
		expect(mode.usageContainer.children).toHaveLength(1);
		pending.resolve(reports(0.9));
		await flushMicrotasks();
		expect(panel()).toContain("80% left");
		expect(panel()).not.toContain("10% left");
	});

	it("re-running show refetches once and replaces the snapshot while keeping the old one visible", async () => {
		await executeBuiltinSlashCommand("/usage show", { ctx: mode });
		await flushMicrotasks();
		expect(panel()).toContain("80% left");
		const pending = Promise.withResolvers<UsageReport[] | null>();
		fetchUsageReports.mockImplementationOnce(() => pending.promise);
		await executeBuiltinSlashCommand("/usage show", { ctx: mode });
		expect(fetchUsageReports).toHaveBeenCalledTimes(2);
		expect(panel()).toContain("80% left");
		expect(panel()).toContain("Fetching usage data");
		pending.resolve(reports(0.7));
		await flushMicrotasks();
		expect(panel()).toContain("30% left");
		expect(panel()).not.toContain("80% left");
		expect(mode.usageContainer.children).toHaveLength(1);
	});

	it("clear unpins, discards a late result, and is a no-op when nothing is pinned", async () => {
		await executeBuiltinSlashCommand("/usage clear", { ctx: mode });
		expect(fetchUsageReports).not.toHaveBeenCalled();
		expect(panel()).toBe("");
		const pending = Promise.withResolvers<UsageReport[] | null>();
		fetchUsageReports.mockImplementationOnce(() => pending.promise);
		await executeBuiltinSlashCommand("/usage", { ctx: mode });
		await executeBuiltinSlashCommand("/usage clear", { ctx: mode });
		expect(panel()).toBe("");
		pending.resolve(reports(0.2));
		await flushMicrotasks();
		expect(panel()).toBe("");
		expect(mode.usageContainer.children).toHaveLength(0);
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
	});

	it("discards a superseded fetch when show is repeated mid-flight", async () => {
		const stale = Promise.withResolvers<UsageReport[] | null>();
		fetchUsageReports.mockImplementationOnce(() => stale.promise);
		mode.setUsagePinned(true);
		mode.setUsagePinned(true);
		expect(fetchUsageReports).toHaveBeenCalledTimes(2);
		await flushMicrotasks();
		expect(panel()).toContain("80% left");
		stale.resolve(reports(0.9));
		await flushMicrotasks();
		expect(panel()).toContain("80% left");
		expect(panel()).not.toContain("10% left");
	});

	for (const cleanup of ["clearTransientSessionUi", "stop"] as const) {
		it(`drops the panel and late results on ${cleanup}`, async () => {
			const pending = Promise.withResolvers<UsageReport[] | null>();
			fetchUsageReports.mockImplementation(() => pending.promise);
			mode.setUsagePinned(true);
			mode[cleanup]();
			expect(panel()).toBe("");
			pending.resolve(reports(0.2));
			await flushMicrotasks();
			expect(panel()).toBe("");
			expect(mode.usageContainer.children).toHaveLength(0);
		});
	}

	it("keeps the snapshot through transcript rebuilds and deferred-output settlement", async () => {
		mode.setUsagePinned(true);
		await flushMicrotasks();
		mode.resetTranscript();
		mode.flushPendingCommandOutput();
		expect(panel()).toContain("80% left");
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		expect(mode.usageContainer.children).toHaveLength(1);
	});

	it("drops data from a replaced session even before lifecycle cleanup", async () => {
		const pending = Promise.withResolvers<UsageReport[] | null>();
		fetchUsageReports.mockImplementation(() => pending.promise);
		mode.setUsagePinned(true);
		Object.defineProperty(mode.session, "sessionId", { value: "replacement-session" });
		pending.resolve(reports(0.2));
		await flushMicrotasks();
		expect(panel()).toBe("");
		expect(mode.usageContainer.children).toHaveLength(0);
	});

	it("keeps the footer for empty reports and errors without refetching", async () => {
		fetchUsageReports.mockResolvedValueOnce(null);
		mode.setUsagePinned(true);
		await flushMicrotasks();
		expect(panel()).toContain("No pooled usage data.");
		expect(panel()).toContain("/usage to hide");
		fetchUsageReports.mockRejectedValueOnce(new Error("offline"));
		mode.setUsagePinned(true);
		await flushMicrotasks();
		expect(panel()).toContain("No pooled usage data.");
		expect(panel()).toContain("Failed to fetch usage data: offline");
		expect(panel()).toContain("Usage snapshot · fetched");
		vi.advanceTimersByTime(10 * 60_000);
		await flushMicrotasks();
		expect(fetchUsageReports).toHaveBeenCalledTimes(2);
	});

	it("rejects on, off, reset, and extra arguments with the help without touching the panel", async () => {
		const status = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		for (const input of ["/usage on", "/usage off", "/usage reset", "/usage show extra", "/usage clear now"]) {
			expect(await executeBuiltinSlashCommand(input, { ctx: mode })).toBe(true);
			expect(status).toHaveBeenLastCalledWith("Usage: /usage [show|clear]");
		}
		expect(status).toHaveBeenCalledTimes(5);
		expect(fetchUsageReports).not.toHaveBeenCalled();
		expect(panel()).toBe("");
	});

	it("offers exactly show and clear completions", async () => {
		const usage = BUILTIN_SLASH_COMMANDS.find(command => command.name === "usage");
		expect(usage?.getArgumentCompletions).toBeDefined();
		const completions = await usage?.getArgumentCompletions?.("");
		expect(completions?.map(item => item.value.trimEnd())).toEqual(["show", "clear"]);
		expect((await usage?.getArgumentCompletions?.("cl"))?.map(item => item.label)).toEqual(["clear"]);
	});
});
