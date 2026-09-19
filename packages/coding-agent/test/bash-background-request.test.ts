/**
 * End-to-end coverage for the `app.tool.background` (Ctrl+B) gesture: a real
 * `Agent` running a real `BashTool` against a long command, backgrounded
 * mid-flight so a queued user prompt is serviced without waiting for the
 * command — which keeps running and delivers its result later.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { Snowflake } from "@oh-my-pi/pi-utils";

let testDir: string;
let artifactCounter = 0;

function createToolSession(cwd: string, asyncJobManager: AsyncJobManager): ToolSession {
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			const id = String(++artifactCounter);
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		getSessionId: () => "background-request-session",
		asyncJobManager,
		// Auto-background stays off: this exercises the ordinary foreground
		// command path, the one the chord has to detach mid-run.
		settings: Settings.isolated({ "bash.autoBackground.enabled": false }),
	} as ToolSession;
}

beforeEach(() => {
	testDir = path.join(os.tmpdir(), `omp-ctrl-b-${Snowflake.next()}`);
	fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(testDir, { recursive: true, force: true });
});

describe("background request (Ctrl+B) end to end", () => {
	it("detaches the running command so a queued prompt is answered immediately", async () => {
		const asyncJobManager = new AsyncJobManager({});
		const bash = new BashTool(createToolSession(testDir, asyncJobManager));
		const marker = path.join(testDir, "still-running.txt");

		// The command outlives the turn by far; only backgrounding can end the
		// tool call in reasonable time.
		const command = `printf 'phase-one\\n'; sleep 30; printf 'done\\n' > ${JSON.stringify(marker)}`;
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command, timeout: 0 } }] },
				{ content: ["backgrounded, here is your answer"] },
			],
		});

		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [bash], messages: [] },
			streamFn: mock.stream,
			getToolContext: toolCall => ({ toolCall }) as AgentToolContext,
			convertToLlm: messages =>
				messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[],
		});

		// The user types a prompt while the command runs, then presses Ctrl+B.
		const commandStarted = Promise.withResolvers<void>();
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "tool_execution_update" && event.toolCallId === "call-1") commandStarted.resolve();
		});
		const promptDone = agent.prompt("run the long command");
		await commandStarted.promise;
		agent.steer({ role: "user", content: "what is 2+2?", timestamp: Date.now() });
		expect(agent.requestToolBackground()).toBe(true);

		await promptDone;
		unsubscribe();

		// The tool call ended with a background handle instead of blocking on the
		// 30s command...
		const toolResult = agent.state.messages.find(m => m.role === "toolResult");
		if (toolResult?.role !== "toolResult") throw new Error("expected a tool result");
		const resultText = toolResult.content.find(block => block.type === "text")?.text ?? "";
		expect(resultText).toContain("Moved to the background at the user's request");
		expect(resultText).toContain("Backgrounded as job");
		expect(resultText).toContain("phase-one");

		// ...and the queued prompt was injected right after that boundary.
		const steeredIndex = agent.state.messages.findIndex(
			m => m.role === "user" && JSON.stringify(m.content).includes("what is 2+2?"),
		);
		expect(steeredIndex).toBeGreaterThan(agent.state.messages.indexOf(toolResult));

		// The detached command was never killed: it is still running.
		const jobs = asyncJobManager.getRunningJobs();
		expect(jobs).toHaveLength(1);
		expect(fs.existsSync(marker)).toBe(false);

		asyncJobManager.cancel(jobs[0].id);
		await asyncJobManager.dispose();
	}, 20_000);
});
