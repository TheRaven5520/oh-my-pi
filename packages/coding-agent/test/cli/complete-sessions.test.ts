import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Complete from "@oh-my-pi/pi-coding-agent/commands/complete";
import { resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

/**
 * `omp __complete sessions` prints each cwd session's id and title or first
 * message. A model can run it through bash, so a private chat (Sprilicred
 * private mode) is never printed; other sessions still are.
 */

const TEST_CONFIG: CliConfig = { bin: "omp", version: "test", commands: new Map() };

function line(obj: unknown): string {
	return `${JSON.stringify(obj)}\n`;
}

function sessionJsonl(id: string, title: string, turns: Array<[role: "user" | "assistant", text: string]>): string {
	const timestamp = new Date().toISOString();
	let content = line({ type: "session", version: 3, id, title, cwd: "/proj", timestamp });
	turns.forEach(([role, text], index) => {
		const message =
			role === "user"
				? { role, content: [{ type: "text", text }], timestamp: index }
				: { role, provider: "anthropic", model: "m", stopReason: "stop", content: [{ type: "text", text }] };
		content += line({ type: "message", id: `${id}-${index}`, parentId: null, timestamp, message });
	});
	return content;
}

describe("omp __complete sessions", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		testAgentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-complete-private-")));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
		resetSessionIndexForTests();
	});

	afterEach(() => {
		resetSessionIndexForTests();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	it("never prints a private session, and still prints ones that only mention `private`", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const write = (id: string, content: string) =>
			fs.writeFileSync(path.join(sessionDir, `2026-09-23T09-10-40-296Z_${id}.jsonl`), content);
		write(
			"private-chat",
			sessionJsonl("private-chat", "Private Access Modifier", [
				["user", "`private`"],
				["assistant", "OK"],
				["user", "the secret plan"],
				["assistant", "noted"],
			]),
		);
		write(
			"mentions",
			sessionJsonl("mentions", "Field visibility", [
				["user", "make the field `private`"],
				["assistant", "OK"],
			]),
		);
		write(
			"answered",
			sessionJsonl("answered", "Model answered", [
				["user", "`private`"],
				["assistant", "What should I keep private?"],
			]),
		);

		const output: string[] = [];
		const cwdSpy = spyOn(process, "cwd").mockReturnValue(cwd);
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		try {
			await new Complete(["sessions"], TEST_CONFIG).run();
		} finally {
			stdoutSpy.mockRestore();
			cwdSpy.mockRestore();
		}

		const printed = output.join("");
		expect(printed).toContain("mentions\tField visibility");
		expect(printed).toContain("answered\tModel answered");
		expect(printed).not.toContain("private-chat");
		expect(printed).not.toContain("Private Access Modifier");
	});
});
