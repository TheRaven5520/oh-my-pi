import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession request_accepted", () => {
	let authStorage: AuthStorage;
	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
	});
	afterAll(() => authStorage.close());

	it("fires when the provider accepts the primary request, before any output, and not on a rejected status", async () => {
		const mockModel = createMockModel({
			responses: [
				{ content: ["accepted"], responseHeaders: {} },
				{ content: ["rejected"], responseHeaders: {}, responseStatus: 429 },
			],
		});
		authStorage.setRuntimeApiKey(mockModel.provider, "test-key");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mockModel, systemPrompt: ["Test"], tools: [] },
				streamFn: mockModel.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const events: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "request_accepted") events.push("request_accepted");
			else if (event.type === "message_update") events.push(`update:${event.assistantMessageEvent.type}`);
		});
		try {
			await session.prompt("first");
			await session.waitForIdle();
			const accepted = events.indexOf("request_accepted");
			const firstOutput = events.findIndex(e => e.startsWith("update:") && e !== "update:start");
			expect(events.filter(e => e === "request_accepted")).toHaveLength(1);
			expect(firstOutput).toBeGreaterThan(-1);
			expect(accepted).toBeLessThan(firstOutput);

			events.length = 0;
			await session.prompt("second");
			await session.waitForIdle();
			expect(events).not.toContain("request_accepted");
		} finally {
			unsubscribe();
			await session.dispose();
		}
	});
});
