import { afterEach, describe, expect, it } from "bun:test";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createForkedSideAgent } from "@oh-my-pi/pi-coding-agent/modes/controllers/forked-side-agent";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("forked side agent", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		unregisterCustomApis("pi-ai/mock");
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	async function fixture(persist = true, mock = createMockModel({ handler: () => ({ content: ["fallback"] }) })) {
		registerMockApi();
		const temp = TempDir.createSync("@omp-forked-side-agent-");
		const auth = await AuthStorage.create(":memory:");
		auth.setRuntimeApiKey("mock", "test-key");
		const registry = new ModelRegistry(auth);
		const manager = persist ? SessionManager.create(temp.path(), temp.path()) : SessionManager.inMemory(temp.path());
		manager.appendMessage({ role: "user", content: "parent context", timestamp: Date.now() });
		if (persist) await manager.ensureOnDisk();
		const { session: parent } = await createAgentSession({
			cwd: temp.path(),
			sessionManager: manager,
			model: mock.model,
			modelRegistry: registry,
			authStorage: auth,
			getApiKey: () => "test-key",
			settings: Settings.isolated({ "compaction.enabled": false }),
			systemPrompt: ["Test"],
			hasUI: false,
			enableMCP: false,
			agentId: "Main",
			agentDisplayName: "main",
		});
		const ctx = {
			session: parent,
			sessionManager: manager,
			settings: parent.settings,
			mcpManager: undefined,
		} as never;
		cleanups.push(async () => {
			await parent.dispose().catch(() => {});
			auth.close();
			temp.removeSync();
		});
		return { temp, manager, mock, parent, ctx };
	}

	it("runs a real tool call in a fork without changing the parent transcript", async () => {
		const file = TempDir.createSync("@omp-forked-tool-");
		await Bun.write(`${file.path()}/input.txt`, "tool payload");
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "read", arguments: { path: `${file.path()}/input.txt` } }] },
				{ content: ["tool complete"] },
			],
		});
		const fixtureData = await fixture(true, mock);
		cleanups.push(async () => file.removeSync());
		const before = fixtureData.manager.getEntries().length;
		const side = await createForkedSideAgent(fixtureData.ctx);
		const result = await side.run({ question: "Read the tool input." });
		expect(result.replyText).toBe("tool complete");
		expect(fixtureData.manager.getEntries()).toHaveLength(before);
		expect(await Bun.file(side.sessionFile).text()).toContain("tool payload");
		await side.close();
	});

	it("parks and revives with prior question and answer context", async () => {
		const mock = createMockModel({ responses: [{ content: ["first answer"] }, { content: ["follow-up answer"] }] });
		const fixtureData = await fixture(true, mock);
		const side = await createForkedSideAgent(fixtureData.ctx);
		await side.run({ question: "first question" });
		await side.park();
		expect((await side.run({ question: "follow-up question" })).replyText).toBe("follow-up answer");
		const context = mock.calls.at(-1)?.context;
		expect(context?.messages.some(message => JSON.stringify(message).includes("first question"))).toBe(true);
		expect(context?.messages.some(message => JSON.stringify(message).includes("first answer"))).toBe(true);
		await side.close();
	});

	it("keeps prior context for an in-memory parent without writing JSONL", async () => {
		const mock = createMockModel({ responses: [{ content: ["memory answer"] }, { content: ["memory follow-up"] }] });
		const fixtureData = await fixture(false, mock);
		const side = await createForkedSideAgent(fixtureData.ctx);
		await side.run({ question: "memory question" });
		expect((await side.run({ question: "memory follow-up question" })).replyText).toBe("memory follow-up");
		expect(
			mock.calls.at(-1)?.context.messages.some(message => JSON.stringify(message).includes("memory question")),
		).toBe(true);
		expect((await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan({ cwd: fixtureData.temp.path() }))).length).toBe(0);
		await side.close();
	});

	it("rejects a mid-turn abort and still settles park", async () => {
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: () => {
				started.resolve();
				return { delayMs: 1000, content: ["late"] };
			},
		});
		const fixtureData = await fixture(true, mock);
		const side = await createForkedSideAgent(fixtureData.ctx);
		const controller = new AbortController();
		const running = side.run({ question: "cancel me", signal: controller.signal });
		await started.promise;
		controller.abort();
		await expect(running).rejects.toThrow();
		await side.park();
		await side.close();
	});
});
