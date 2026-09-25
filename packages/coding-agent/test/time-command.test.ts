import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { setClockTimeZone } from "@oh-my-pi/pi-tui/render/clock";

function harness(timestamps: boolean, collabGuest = false) {
	// Isolated overrides outrank set(), so seed the value as a normal write.
	const settings = Settings.isolated();
	settings.set("display.timestamps", timestamps);
	const ctx = {
		settings,
		collabGuest,
		rebuildChatFromMessages: vi.fn(),
		ui: { resetDisplay: vi.fn() },
		showStatus: vi.fn(),
		editor: { setText: vi.fn() },
	};
	const run = (text: string) =>
		executeBuiltinSlashCommand(text, { ctx } as unknown as Parameters<typeof executeBuiltinSlashCommand>[1]);
	return { ctx, run };
}

afterEach(() => {
	setClockTimeZone(undefined);
	setChatTranscriptDisplayPreferences({ showTimestamps: false });
});

describe("/time", () => {
	it("toggles timestamps, then rebuilds and resets the display so committed rows change too", async () => {
		const { ctx, run } = harness(false);
		setClockTimeZone("America/New_York");

		expect(await run("/time")).toBe(true);
		expect(ctx.settings.get("display.timestamps")).toBe(true);
		expect(chatTranscriptDisplayPreferences.showTimestamps).toBe(true);
		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(ctx.ui.resetDisplay).toHaveBeenCalledTimes(1);
		expect(ctx.showStatus).toHaveBeenLastCalledWith(expect.stringMatching(/^Timestamps on · E[SD]T$/));

		await run("/time");
		expect(ctx.settings.get("display.timestamps")).toBe(false);
		expect(chatTranscriptDisplayPreferences.showTimestamps).toBe(false);
		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(2);
	});

	it("does not rebuild for on when already on, for status, or for bad input", async () => {
		const { ctx, run } = harness(true);
		await run("/time on");
		await run("/time status");
		await run("/time sideways");
		expect(ctx.settings.get("display.timestamps")).toBe(true);
		expect(ctx.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(ctx.ui.resetDisplay).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenLastCalledWith("Usage: /time [on|off|status]");

		await run("/time off");
		expect(ctx.settings.get("display.timestamps")).toBe(false);
		expect(ctx.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
	});

	it("runs locally for a collab guest, since timestamps are a display preference", async () => {
		const { ctx, run } = harness(false, true);
		await run("/time on");
		expect(ctx.settings.get("display.timestamps")).toBe(true);
		expect(ctx.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("host-only"));
	});
});
