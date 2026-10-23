import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { centralTranscript } from "../src/modes/controllers/extension-ui-controller";

const TS = Date.now() - 60_000;

const messages = [
	{
		role: "custom",
		customType: "irc:incoming",
		content: "[IRC message from HQ]\n\nincoming body",
		display: true,
		details: { id: "irc-1", from: "HQ", message: "incoming body", wakeRelay: true, fromParent: true },
		attribution: "agent",
		timestamp: TS,
	},
	{
		role: "custom",
		customType: "irc:relay",
		content: "[IRC `Alpha` → `Beta`]\n\nrelay body",
		display: true,
		details: { from: "Alpha", to: "Beta", body: "relay body" },
		timestamp: TS,
	},
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "call-wait", name: "wait", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: TS,
	},
	{
		role: "toolResult",
		toolCallId: "call-wait",
		toolName: "wait",
		content: [{ type: "text", text: "Message from Gamma" }],
		details: {
			op: "wait",
			waited: { id: "irc-2", from: "Gamma", to: "main", body: "waited body", ts: TS },
			jobs: [{ id: "job-1", resultText: "x".repeat(50_000) }],
		},
		isError: false,
		timestamp: TS,
	},
] as unknown as AgentMessage[];

/** Central's path: serialize like the bridge's transcript op, then rebuild like Central's transcript pane. */
function renderCentral(source: AgentMessage[], verbose = false): string {
	const builder = new ChatTranscriptBuilder({
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
		cwd: process.cwd(),
		requestRender: () => {},
	});
	if (verbose) builder.setToolDisplayState("verbose");
	builder.rebuild(centralTranscript(source));
	return Bun.stripANSI(builder.container.children.flatMap(child => child.render(120)).join("\n"));
}

describe("Central transcript IRC records", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("keeps only the card fields of IRC and wait details", () => {
		const entries = centralTranscript(messages);
		const details = entries.map(entry =>
			entry.type === "message" ? Reflect.get(entry.message, "details") : undefined,
		);
		expect(details[0]).toEqual({ from: "HQ", message: "incoming body" });
		expect(details[1]).toEqual({ from: "Alpha", to: "Beta", body: "relay body" });
		expect(details[2]).toBeUndefined();
		expect(details[3]).toEqual({ waited: { from: "Gamma", body: "waited body", ts: TS } });
	});

	it("renders the real sender and body through the transcript builder", () => {
		const rendered = renderCentral(messages);
		expect(rendered).toContain(`IRC ${theme.nav.back} HQ`);
		expect(rendered).toContain("incoming body");
		expect(rendered).toContain(`IRC Alpha ${theme.nav.selected} Beta`);
		expect(rendered).toContain("relay body");
		// The wait result's activity row names the sender from `details.waited.from`.
		expect(rendered).toMatch(/IRC ←\s+Gamma/);
		expect(rendered).not.toContain("?");
		expect(rendered).not.toContain("unknown sender");

		const full = renderCentral(messages, true);
		expect(full).toContain(`IRC ${theme.nav.back} Gamma`);
		expect(full).toContain("waited body");
	});

	it("labels a record that names no sender instead of showing a question mark", () => {
		const rendered = renderCentral([
			{ role: "custom", customType: "irc:relay", content: "relay", display: true, timestamp: TS },
		] as unknown as AgentMessage[]);
		expect(rendered).toContain(`IRC unknown sender ${theme.nav.selected} unknown recipient`);
		expect(rendered).not.toContain("?");
	});
});
