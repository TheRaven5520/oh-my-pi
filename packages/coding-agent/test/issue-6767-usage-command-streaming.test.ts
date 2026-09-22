import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

const usageReports: UsageReport[] = [
	{
		provider: "openai-codex",
		fetchedAt: 1_700_000_000_000,
		limits: [
			{
				id: "chat:secondary",
				label: "Weekly",
				scope: { provider: "openai-codex", windowId: "chat:secondary" },
				window: { id: "7d", label: "weekly", durationMs: 604_740_000 },
				amount: { usedFraction: 0.75, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { sprilicredAccountId: "acct-1" },
	},
];

describe("issue #6767 /usage output during streaming", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let streaming = true;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-6767-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.close();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("opens the usage dashboard overlay without touching the transcript, even mid-stream", async () => {
		const streamedReply = new Text("agent is streaming", 0, 0);
		mode.chatContainer.addChild(streamedReply);
		const showDashboard = vi.fn();
		mode.showUsageDashboard = showDashboard;

		await mode.handleUsageCommand(usageReports);

		// /usage renders as an overlay (the /settings idiom): nothing may mount
		// into the transcript, mid-stream or otherwise — mounting above the
		// growing live block is what duplicated in native scrollback (#6767).
		expect(showDashboard).toHaveBeenCalledTimes(1);
		expect(showDashboard).toHaveBeenCalledWith(usageReports);
		expect(mode.chatContainer.children).toEqual([streamedReply]);

		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		// Turn end must not flush any deferred usage panel either.
		expect(mode.chatContainer.children).toEqual([streamedReply]);
	});

	it("pins the usage snapshot during streaming without transcript insertion and keeps it until clear", async () => {
		const fetchUsageReports = vi.spyOn(session, "fetchUsageReports").mockResolvedValue(usageReports);
		const streamedReply = new Text("agent is streaming", 0, 0);
		mode.chatContainer.addChild(streamedReply);

		expect(await executeBuiltinSlashCommand("/usage show", { ctx: mode })).toBe(true);
		for (let i = 0; i < 10; i++) await Promise.resolve();

		expect(fetchUsageReports).toHaveBeenCalledTimes(1);
		expect(mode.chatContainer.children).toEqual([streamedReply]);
		expect(mode.deferredCommandContainer.children).toHaveLength(0);
		expect(mode.usageContainer.children).toHaveLength(1);
		const pinned = stripVTControlCharacters(mode.usageContainer.render(120).join("\n"));
		expect(pinned).toContain("Usage snapshot");
		expect(pinned).toContain("- Weekly    [xxxxxxxx--]");

		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.chatContainer.children).toEqual([streamedReply]);
		expect(mode.deferredCommandContainer.children).toHaveLength(0);
		expect(mode.usageContainer.children).toHaveLength(1);
		expect(stripVTControlCharacters(mode.usageContainer.render(120).join("\n"))).toContain("[xxxxxxxx--]");
		expect(mode.chatContainer.render(120).join("\n")).not.toContain("Usage");
		expect(fetchUsageReports).toHaveBeenCalledTimes(1);

		await executeBuiltinSlashCommand("/usage clear", { ctx: mode });
		expect(mode.usageContainer.children).toHaveLength(0);
		expect(mode.chatContainer.children).toEqual([streamedReply]);
		expect(mode.deferredCommandContainer.children).toHaveLength(0);
	});
});
