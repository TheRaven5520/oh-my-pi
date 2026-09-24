import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession file history", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeAll(() => registerMockApi());
	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage?.close();
		await tempDir?.remove();
	});

	/** A model that answers every prompt by writing `notes.txt` = `v<n>` through the real write tool. */
	function writingModel(): MockModel {
		let prompts = 0;
		return createMockModel({
			handler: (context: Context) => {
				if (context.messages.at(-1)?.role !== "user") return { content: ["done"] };
				prompts++;
				return {
					content: [{ type: "toolCall", name: "write", arguments: { path: "notes.txt", content: `v${prompts}` } }],
				};
			},
		});
	}

	async function open(sessionManager: SessionManager, model: MockModel): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false, "advisor.enabled": false }),
			model: model.model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		return session;
	}

	it("restores tool-written files to their state at each prompt, after a resume", async () => {
		tempDir = TempDir.createSync("@omp-file-history-session-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const model = writingModel();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const notes = tempDir.join("notes.txt");
		const sessionFile = SessionManager.createEmptySessionFile(tempDir.path());

		const session = await open(await SessionManager.open(sessionFile), model);
		await session.prompt("first");
		await session.waitForIdle();
		await session.prompt("second");
		await session.waitForIdle();
		expect(fs.readFileSync(notes, "utf8")).toBe("v2");
		const prompts = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && entry.message.role === "user")
			.map(entry => entry.id);
		expect(prompts).toHaveLength(2);
		await session.sessionManager.flush();

		// A new session over the same file sees the persisted history, as after `--resume`.
		const resumed = await open(await SessionManager.open(sessionFile), createMockModel());
		expect((await resumed.fileHistory.restore(prompts[1]!)).restored).toEqual([path.resolve(notes)]);
		expect(fs.readFileSync(notes, "utf8")).toBe("v1");
		await resumed.fileHistory.restore(prompts[0]!);
		expect(fs.existsSync(notes)).toBe(false);
	});
});
