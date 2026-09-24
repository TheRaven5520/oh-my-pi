import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// The owner's ask: "if I switch the thinking level, it will remember that".
// One level the user chose, re-clamped for each model Ctrl+P lands on: a model
// with a shorter effort ladder must not lower the level
// the next model gets, and Shift+Tab's choice outlives the session.
describe("remembered thinking level across Ctrl+P and sessions", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let sessions: AgentSession[];

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-remember-thinking-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelsPath = path.join(tempDir, "models.yml");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "https://gateway.example/anthropic",
						apiKey: "gateway-key",
						auth: "oauth",
						authHeader: true,
						api: "anthropic-messages",
						models: [
							{ id: "claude-opus-5-5" },
							// A shorter effort ladder, as Haiku has below Opus.
							{
								id: "claude-short-ladder",
								reasoning: true,
								thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high"] },
							},
						],
					},
				},
			}),
		);
		registry = new ModelRegistry(authStorage, modelsPath);
		sessions = [];
	});

	afterEach(async () => {
		for (const session of sessions) await session.dispose();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	/** Settings as a person's config.yml has them; `set` writes through, unlike isolated overrides. */
	function settingsWith(level: Effort): Settings {
		const settings = Settings.isolated();
		settings.set("defaultThinkingLevel", level);
		return settings;
	}

	function start(settings: Settings, sessionManager = SessionManager.inMemory()): AgentSession {
		const model = registry.find("gateway", "claude-opus-5-5");
		if (!model) throw new Error("missing gateway/claude-opus-5-5");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry: registry,
			thinkingLevel: settings.get("defaultThinkingLevel") as Effort,
		});
		sessions.push(session);
		return session;
	}

	test("xhigh survives a pass through a shorter ladder, and is what a resume restores", async () => {
		const sessionManager = SessionManager.inMemory();
		const session = start(settingsWith(Effort.High), sessionManager);
		session.setThinkingLevel(Effort.XHigh);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		const toShort = await session.cycleModelPatterns(["gateway/*"]);
		expect(toShort?.model.id).toBe("claude-short-ladder");
		expect(session.thinkingLevel).toBe(Effort.High);
		// The transcript records the level asked for, which is what a resume restores.
		expect(sessionManager.buildSessionContext().configuredThinkingLevel).toBe(Effort.XHigh);

		const backToOpus = await session.cycleModelPatterns(["gateway/*"]);
		expect(backToOpus?.model.id).toBe("claude-opus-5-5");
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	test("Shift+Tab's level becomes the default for new sessions; a role's own level does not", async () => {
		const settings = settingsWith(Effort.High);
		const first = start(settings);
		let picked = first.cycleThinkingLevel();
		while (picked !== Effort.Low) picked = first.cycleThinkingLevel();
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);

		settings.setModelRole("quick", "gateway/claude-short-ladder:medium");
		await first.cycleRoleModels(["default", "quick"]);
		expect(first.thinkingLevel).toBe(Effort.Medium);
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);

		const next = start(settings);
		expect(next.thinkingLevel).toBe(Effort.Low);
	});
});
