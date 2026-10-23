import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCentralFocusCommands } from "../src/central/focus-commands";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function stubMailbox(exitCode = 0): Promise<{ dir: string; hqmsg: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-central-focus-"));
	dirs.push(dir);
	const hqmsg = path.join(dir, "hqmsg");
	await fs.writeFile(
		hqmsg,
		`#!/usr/bin/env bun\nconsole.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(${exitCode});\n`,
		{ mode: 0o755 },
	);
	return { dir, hqmsg };
}

describe("Central focus local commands", () => {
	it("routes /send through the coordinator mailbox as a relay, never as a chat prompt", async () => {
		const { hqmsg } = await stubMailbox();
		const commands = createCentralFocusCommands({ hqmsg, pauseFile: "", boardUrl: "" });
		expect(JSON.parse(await commands.relay("SPRILISTACK", "-rebase now"))).toEqual([
			"--from",
			"FOCUS",
			"--kind",
			"relay",
			"--to=SPRILISTACK",
			"--",
			"-rebase now",
		]);
		expect(JSON.parse(await commands.inbox(3))).toEqual(["--tail", "3"]);
	});

	it("reports a failing mailbox with its output", async () => {
		const { hqmsg } = await stubMailbox(2);
		const commands = createCentralFocusCommands({ hqmsg, pauseFile: "", boardUrl: "" });
		await expect(commands.inbox(1)).rejects.toThrow("exited with 2");
	});

	it("creates and removes the pause file and reports the resulting state", async () => {
		const { dir } = await stubMailbox();
		const pauseFile = path.join(dir, "inbox-steer.paused");
		const commands = createCentralFocusCommands({ hqmsg: "", pauseFile, boardUrl: "https://board.example/" });
		expect(await commands.setPaused(true)).toBe(`Inbox steering paused (${pauseFile} exists)`);
		expect(await fs.exists(pauseFile)).toBe(true);
		expect(await commands.setPaused(true)).toContain("paused");
		expect(await commands.setPaused(false)).toBe(`Inbox steering running (${pauseFile} absent)`);
		expect(await fs.exists(pauseFile)).toBe(false);
		expect(commands.boardUrl()).toBe("https://board.example/");
	});

	it("says which setting is missing instead of guessing a personal path", async () => {
		const commands = createCentralFocusCommands({ hqmsg: " ", pauseFile: "", boardUrl: "" });
		await expect(commands.relay("HQ", "hi")).rejects.toThrow("Not configured: set central.focus.hqmsg");
		await expect(commands.inbox(10)).rejects.toThrow("Not configured: set central.focus.hqmsg");
		await expect(commands.setPaused(true)).rejects.toThrow("Not configured: set central.focus.pauseFile");
		expect(() => commands.boardUrl()).toThrow("Not configured: set central.focus.boardUrl");
	});
});
