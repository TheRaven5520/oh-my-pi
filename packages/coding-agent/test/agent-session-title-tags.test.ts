import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TAG_CHECK_EVERY_PROMPTS } from "@oh-my-pi/pi-coding-agent/session/session-tag";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession tag-style titles", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let previousNoTitle: string | undefined;

	beforeEach(() => {
		// Other suites set PI_NO_TITLE process-wide; titling must run here.
		previousNoTitle = Bun.env.PI_NO_TITLE;
		delete Bun.env.PI_NO_TITLE;
	});
	afterEach(async () => {
		if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
		else Bun.env.PI_NO_TITLE = previousNoTitle;
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		session = undefined;
	});

	it("names with a tag, renames only after two checks agree, and never overrides a manual name", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: createMockModel({ handler: () => ({ content: ["ok"] }) }).stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "title.style": "tag" }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const active = session;
		const checks: string[] = [];
		const generateTitle = vi.spyOn(active, "generateTitle").mockImplementation(async (_context, systemPrompt) => {
			if (systemPrompt?.includes("is tagged `")) {
				checks.push(systemPrompt.match(/tagged `([^`]+)`/)?.[1] ?? "?");
				return "pi05 evals";
			}
			return "Sprilicred";
		});
		const send = async (count: number) => {
			for (let i = 0; i < count; i++) {
				await active.prompt(`message ${i}`);
				await active.waitForIdle();
			}
			await Bun.sleep(20);
		};

		active.maybeStartTitleGeneration("the sprilicred gateway returns 400 for defer_loading");
		await Bun.sleep(20);
		expect(active.sessionName).toBe("SPRILICRED");

		// First check proposing a change is not enough.
		await send(TAG_CHECK_EVERY_PROMPTS);
		expect(checks).toEqual(["SPRILICRED"]);
		expect(active.sessionName).toBe("SPRILICRED");

		// The next check agreeing renames.
		await send(TAG_CHECK_EVERY_PROMPTS);
		expect(checks).toEqual(["SPRILICRED", "SPRILICRED"]);
		expect(active.sessionName).toBe("PI05 EVALS");

		// A manual name is final: no further checks, not even model calls.
		const callsBeforeManualName = generateTitle.mock.calls.length;
		await active.sessionManager.setSessionName("my name", "user");
		await send(TAG_CHECK_EVERY_PROMPTS * 2);
		expect(generateTitle.mock.calls.length).toBe(callsBeforeManualName);
		expect(active.sessionName).toBe("my name");
	});
});
