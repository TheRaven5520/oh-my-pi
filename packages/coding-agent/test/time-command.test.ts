import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgDisplayTimeZone, cfgDisplayTimestamps } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { setClockTimeZone } from "@oh-my-pi/pi-tui/render/clock";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

let mode: InteractiveMode | undefined;
let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempDir: TempDir | undefined;

async function harness(timestamps: boolean, collabGuest = false, timeZone = "UTC") {
	resetSettingsForTest();
	tempDir = TempDir.createSync("@pi-time-command-");
	const settings = await Settings.init({
		inMemory: true,
		cwd: tempDir.path(),
		overrides: { "startup.quiet": true },
	});
	cfgDisplayTimestamps.set(settings, timestamps);
	cfgDisplayTimeZone.set(settings, timeZone);
	await initTheme(false);
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	const message = {
		role: "user" as const,
		content: "A committed prompt",
		timestamp: Date.UTC(2026, 0, 2, 17, 34, 56),
	};
	const sessionManager = SessionManager.inMemory(tempDir.path());
	sessionManager.appendMessage(message);
	session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [message] } }),
		sessionManager,
		settings,
		modelRegistry,
	});
	const ctx = (mode = new InteractiveMode(session, "test"));
	// Exercise init's real settings subscription without starting a terminal or git watcher.
	vi.spyOn(ctx.ui, "start").mockImplementation(() => {});
	vi.spyOn(ctx.ui, "requestRender").mockImplementation(() => {});
	vi.spyOn(ctx.ui, "renderNow").mockImplementation(() => {});
	vi.spyOn(ctx.statusLine, "watchBranch").mockImplementation(() => {});
	await ctx.init({ suppressWelcomeIntro: true });
	await ctx.renderInitialMessages();
	vi.spyOn(ctx, "rebuildChatFromMessages");
	vi.spyOn(ctx.ui, "resetDisplay");
	vi.spyOn(ctx, "showStatus").mockImplementation(() => {});
	const run = (text: string) =>
		executeBuiltinSlashCommand(text, {
			ctx: { settings, editor: ctx.editor, showStatus: ctx.showStatus, collabGuest },
		} as unknown as Parameters<typeof executeBuiltinSlashCommand>[1]);
	const transcript = () => Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
	return { ctx, run, transcript };
}

afterEach(async () => {
	mode?.stop();
	mode = undefined;
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
	resetSettingsForTest();
	vi.restoreAllMocks();
	setClockTimeZone(undefined);
	setChatTranscriptDisplayPreferences({ showTimestamps: false });
});

describe("/time", () => {
	it("toggles timestamps, then rebuilds and resets the display so committed rows change too", async () => {
		const { ctx, run, transcript } = await harness(false, false, "America/New_York");
		expect(transcript()).toContain("A committed prompt");
		expect(transcript()).not.toContain("12:34:56");

		expect(await run("/time")).toBe(true);
		expect(cfgDisplayTimestamps.get(ctx.settings)).toBe(true);
		expect(chatTranscriptDisplayPreferences.showTimestamps).toBe(true);
		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(ctx.ui.resetDisplay).toHaveBeenCalledTimes(1);
		expect(transcript()).toContain("12:34:56");
		expect(ctx.showStatus).toHaveBeenLastCalledWith(expect.stringMatching(/^Timestamps on · E[SD]T$/));

		await run("/time");
		expect(cfgDisplayTimestamps.get(ctx.settings)).toBe(false);
		expect(chatTranscriptDisplayPreferences.showTimestamps).toBe(false);
		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(2);
		expect(ctx.ui.resetDisplay).toHaveBeenCalledTimes(2);
		expect(transcript()).toContain("A committed prompt");
		expect(transcript()).not.toContain("12:34:56");
	});

	it("does not rebuild for on when already on, for status, or for bad input", async () => {
		const { ctx, run } = await harness(true);
		await run("/time on");
		await run("/time status");
		await run("/time sideways");
		expect(cfgDisplayTimestamps.get(ctx.settings)).toBe(true);
		expect(ctx.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(ctx.ui.resetDisplay).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenLastCalledWith("Usage: /time [on|off|status]");

		await run("/time off");
		expect(cfgDisplayTimestamps.get(ctx.settings)).toBe(false);
		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(ctx.ui.resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("runs locally for a collab guest, since timestamps are a display preference", async () => {
		const { ctx, run } = await harness(false, true);
		await run("/time on");
		expect(cfgDisplayTimestamps.get(ctx.settings)).toBe(true);
		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(ctx.ui.resetDisplay).toHaveBeenCalledTimes(1);
		expect(ctx.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("host-only"));
	});
});
