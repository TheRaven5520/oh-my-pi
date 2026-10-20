import { beforeAll, describe, expect, it, vi } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { cfgDisplayTimestamps } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import type { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";

beforeAll(async () => {
	await initTheme(false);
});

function fixture() {
	const settings = Settings.isolated();
	const ctx = createInteractiveModeContext({
		settings,
		hideThinkingBlock: true,
		hasDisplayableThinkingContent: true,
		ui: { resetDisplay: vi.fn() },
	});
	const input = new InputController(ctx);
	ctx.toggleThinkingBlockVisibility = () => input.toggleThinkingBlockVisibility();
	const message: AssistantMessage = {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		content: [
			{ type: "thinking", thinking: "Retained reasoning before a tool." },
			{ type: "text", text: "Visible answer." },
		],
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const component = new AssistantMessageComponent(message, true);
	ctx.chatContainer.addChild(component);
	const run = (command: string) => executeBuiltinSlashCommand(command, { ctx, draftDetached: true });
	const render = () => {
		component.invalidate();
		return Bun.stripANSI(component.render(100).join("\n"));
	};
	return { ctx, settings, run, render };
}

describe("thinking and time display commands", () => {
	it("shows and hides retained thinking without changing model effort", async () => {
		const f = fixture();
		const level = f.ctx.viewSession.thinkingLevel;
		expect(f.render()).not.toContain("Retained reasoning");
		await f.run("/thinking on");
		expect(f.render()).toContain("Retained reasoning");
		await f.run("/thinking on");
		expect(f.render()).toContain("Retained reasoning");
		await f.run("/thinking");
		expect(f.render()).not.toContain("Retained reasoning");
		expect(f.render()).toContain("Visible answer.");
		await f.run("/thinking off");
		expect(f.ctx.hideThinkingBlock).toBe(true);
		expect(f.ctx.viewSession.thinkingLevel).toBe(level);
	});

	it("does not treat effort arguments as a thinking display setting", async () => {
		const f = fixture();
		const level = f.ctx.viewSession.thinkingLevel;
		await f.run("/thinking high");
		expect(f.ctx.hideThinkingBlock).toBe(true);
		expect(f.ctx.viewSession.thinkingLevel).toBe(level);
	});

	it("allows guests to reveal thinking locally", async () => {
		const f = fixture();
		f.ctx.collabGuest = {} as CollabGuestLink;
		await f.run("/thinking on");
		expect(f.render()).toContain("Retained reasoning");
	});

	it("toggles timestamps independently and accepts explicit on/off idempotently", async () => {
		const f = fixture();
		await f.run("/time on");
		expect(cfgDisplayTimestamps.get(f.settings)).toBe(true);
		await f.run("/time on");
		expect(cfgDisplayTimestamps.get(f.settings)).toBe(true);
		await f.run("/time");
		expect(cfgDisplayTimestamps.get(f.settings)).toBe(false);
		await f.run("/time off");
		expect(cfgDisplayTimestamps.get(f.settings)).toBe(false);
		expect(f.ctx.hideThinkingBlock).toBe(true);
	});
});
