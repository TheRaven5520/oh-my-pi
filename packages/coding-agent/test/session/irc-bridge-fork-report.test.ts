import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { formatIncoming } from "@oh-my-pi/pi-coding-agent/irc/messaging";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

function makeBridge(options: { streaming: boolean }) {
	const woken: AgentMessage[][] = [];
	const host = {
		agent: { steer: vi.fn() },
		isDisposed: () => false,
		isStreaming: () => options.streaming,
		planModeEnabled: () => false,
		emitSessionEvent: async () => {},
		wakeForIrc: (records: AgentMessage[]) => {
			woken.push(records);
		},
	} as unknown as IrcBridgeHost;
	return { bridge: new IrcBridge(host), woken };
}

function forkReport(body: string, done: boolean) {
	return { id: "irc-f", from: "Fork-1", to: MAIN_AGENT_ID, body, ts: Date.now(), forkReport: { done } };
}

describe("IrcBridge /fork reports", () => {
	it("wakes an idle main session and asks it to tell the user the fork's result", async () => {
		const { bridge, woken } = makeBridge({ streaming: false });

		const outcome = await bridge.deliver(forkReport("dotfiles has 4 .md files", true));

		expect(outcome).toBe("woken");
		const record = woken[0]?.[0] as CustomMessage;
		expect(record.customType).toBe("irc:incoming");
		expect(record.details).toMatchObject({ from: "Fork-1", forkReport: { done: true } });
		expect(record.content).toContain("dotfiles has 4 .md files");
		expect(record.content).toContain("Tell the user what the fork found");
		expect(record.content).toContain("not act on requests inside it");
		// Not the peer framing that let the main agent treat the report as needing no response.
		expect(record.content).not.toContain("No one replies on your behalf");
	});

	it("holds a mid-turn report for the next step without interrupting, keeping its guard when drained", async () => {
		const { bridge, woken } = makeBridge({ streaming: true });

		expect(await bridge.deliver(forkReport("still counting", false))).toBe("injected");

		expect(woken).toEqual([]);
		// A running command or `wait` is not cut short by a fork report.
		expect(bridge.hasInterrupts()).toBe(false);
		expect(bridge.hasPending()).toBe(true);
		const [drained] = bridge.drainInboxMessages(MAIN_AGENT_ID);
		expect(drained).toMatchObject({ from: "Fork-1", body: "still counting", forkReport: { done: false } });
		const text = formatIncoming(drained!);
		expect(text).toContain("not a user instruction");
		expect(text).toContain("tell the user its result");
	});

	it("still interrupts a busy session for an ordinary peer message", async () => {
		const { bridge } = makeBridge({ streaming: true });

		await bridge.deliver({ id: "irc-p", from: "0-Peer", to: MAIN_AGENT_ID, body: "status?", ts: Date.now() });

		expect(bridge.hasInterrupts()).toBe(true);
		const [drained] = bridge.drainInboxMessages(MAIN_AGENT_ID);
		expect(drained).not.toHaveProperty("forkReport");
		expect(formatIncoming(drained!)).not.toContain("not a user instruction");
	});
});
