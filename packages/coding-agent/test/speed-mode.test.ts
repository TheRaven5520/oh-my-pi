import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, ModelSpec, SpeedOutcome } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { describeSpeedOutcome } from "@oh-my-pi/pi-coding-agent/session/speed-notice";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";

function openaiModel(provider: string): Model<Api> {
	return buildModel({
		id: "gpt-6-astra",
		name: "gpt-6-astra",
		api: "openai-responses",
		provider,
		baseUrl: "https://gateway.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	} as ModelSpec<"openai-responses">);
}

function turn(speed: SpeedOutcome | undefined, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider: "sprilicred-openai",
		model: "gpt-6-astra",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(speed ? { speed } : {}),
		timestamp: Date.now(),
	};
}

describe("/fast and /ultrafast", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-speed-mode-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(model: Model<Api>, sessionManager = SessionManager.inMemory()): AgentSession {
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		authStorage.keys.setRuntime(model.provider, "token");
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "retry.enabled": false, "compaction.enabled": false }),
			modelRegistry,
		});
		return session;
	}

	async function run(current: AgentSession, text: string): Promise<string[]> {
		const output: string[] = [];
		const runtime = {
			session: current,
			sessionManager: current.sessionManager,
			settings: current.settings,
			cwd: tempDir.path(),
			output: (line: string) => {
				output.push(line);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;
		expect(await executeAcpBuiltinSlashCommand(text, runtime)).toEqual({ consumed: true });
		return output;
	}

	it("turning ultrafast on turns fast off, and the reverse, saying so", async () => {
		const current = createSession(openaiModel("sprilicred-openai"));
		expect(await run(current, "/fast on")).toEqual(["Fast mode enabled."]);
		expect(await run(current, "/ultrafast on")).toEqual(["Ultrafast enabled; fast mode disabled."]);
		expect(current.serviceTierByFamily).toEqual({ openai: "ultrafast" });
		expect(await run(current, "/fast on")).toEqual(["Fast mode enabled; ultrafast disabled."]);
		expect(current.serviceTierByFamily).toEqual({ openai: "priority" });
	});

	it("toggles with no argument and sets on/off deterministically", async () => {
		const current = createSession(openaiModel("sprilicred-openai"));
		expect(await run(current, "/ultrafast")).toEqual(["Ultrafast enabled."]);
		expect(await run(current, "/ultrafast toggle")).toEqual(["Ultrafast disabled."]);
		expect(await run(current, "/ultrafast off")).toEqual(["Ultrafast disabled."]);
		expect(current.isUltrafastModeEnabled()).toBe(false);
		expect(await run(current, "/ultrafast on")).toEqual(["Ultrafast enabled."]);
		expect(await run(current, "/ultrafast on")).toEqual(["Ultrafast enabled."]);
		expect(await run(current, "/ultrafast status")).toEqual(["Ultrafast is on."]);
	});

	it("refuses ultrafast on a model outside Sprilicred and changes nothing", async () => {
		const current = createSession(openaiModel("personal-openai"));
		current.setFastMode(true);
		expect(await run(current, "/ultrafast on")).toEqual([
			"Ultrafast isn't available on personal-openai/gpt-6-astra: only Sprilicred's OpenAI models offer it. Nothing changed.",
		]);
		expect(current.serviceTierByFamily).toEqual({ openai: "priority" });
	});

	it("keeps ultrafast across a session save and reload", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const current = createSession(openaiModel("sprilicred-openai"), sessionManager);
		current.setUltrafastMode(true);
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reloaded = await SessionManager.open(sessionFile);
		expect(reloaded.buildSessionContext().serviceTier).toEqual({ openai: "ultrafast" });
		await reloaded.close();
	});

	it("shows a speed outcome once per change of outcome", async () => {
		const current = createSession(openaiModel("sprilicred-openai"));
		current.setUltrafastMode(true);
		const notices: string[] = [];
		current.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		const forwarded: SpeedOutcome = { requested: "ultrafast", forwarded: "ultrafast", reason: "forwarded" };
		const atFast: SpeedOutcome = { requested: "ultrafast", forwarded: "fast", reason: "no_pro500_capacity" };
		// An older Sprilicred refused the turn outright; that always shows.
		const refused: SpeedOutcome = { requested: "ultrafast", reason: "no_pro500_capacity", refused: true };
		for (const message of [
			turn(forwarded),
			turn(forwarded),
			turn(atFast),
			turn(atFast),
			turn(forwarded),
			turn(refused, "error"),
			turn(refused, "error"),
		]) {
			current.agent.emitExternalEvent({ type: "message_end", message });
		}
		await current.waitForIdle();
		expect(notices).toEqual([
			"Ultrafast mode on.",
			"Ultrafast unavailable (no Pro 500 account has room); using fast mode.",
			"Ultrafast mode on.",
			"Ultrafast refused: no Pro 500 account has room.",
			"Ultrafast refused: no Pro 500 account has room.",
		]);
	});
});

describe("speed outcome messages", () => {
	const cases: Array<[string, SpeedOutcome, AssistantMessage["stopReason"], string | undefined]> = [
		[
			"fast forwarded",
			{ requested: "fast", forwarded: "fast", reason: "forwarded" },
			"stop",
			"Upgraded to fast mode.",
		],
		[
			"ultrafast forwarded",
			{ requested: "ultrafast", forwarded: "ultrafast", reason: "forwarded" },
			"stop",
			"Ultrafast mode on.",
		],
		[
			"ultrafast with no Pro 500 room falls back to fast",
			{ requested: "ultrafast", forwarded: "fast", reason: "no_pro500_capacity" },
			"stop",
			"Ultrafast unavailable (no Pro 500 account has room); using fast mode.",
		],
		[
			"fast on a subscription account",
			{ requested: "fast", forwarded: "standard", reason: "subscription_extra_usage" },
			"stop",
			"Fast mode unavailable on a subscription account (would bill API-priced extra usage); using standard.",
		],
		[
			"API fallback refused",
			{ requested: "fast", forwarded: "standard", reason: "api_fallback_refused" },
			"stop",
			"Refused fallback to API pricing; using standard.",
		],
		[
			"ultrafast not permitted, fast not either",
			{ requested: "ultrafast", forwarded: "standard", reason: "not_permitted" },
			"stop",
			"Ultrafast unavailable (not enabled for you); using standard.",
		],
		[
			"no headers, provider served standard",
			{ requested: "fast", served: "standard" },
			"stop",
			"Fast mode requested; served at standard.",
		],
		[
			"forwarded ultrafast served at fast",
			{ requested: "ultrafast", forwarded: "ultrafast", reason: "forwarded", served: "fast" },
			"stop",
			"Ultrafast requested; served at fast.",
		],
		[
			"an unrelated failure says nothing",
			{ requested: "fast", forwarded: "fast", reason: "forwarded" },
			"error",
			undefined,
		],
		["nobody reported the tier", { requested: "fast" }, "stop", undefined],
	];
	for (const [label, speed, stopReason, text] of cases) {
		it(label, () => {
			expect(describeSpeedOutcome(turn(speed, stopReason), undefined, "m")?.text).toBe(text);
		});
	}

	it("says a wanted tier was not sent when the model can't carry it", () => {
		expect(describeSpeedOutcome(turn(undefined), "ultrafast", "personal-openai/gpt-6-astra")?.text).toBe(
			"Ultrafast not sent: personal-openai/gpt-6-astra isn't a Sprilicred OpenAI model.",
		);
	});
});
