import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCentralFocusCommands } from "../src/central/focus-commands";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("Central focus local commands", () => {
	it("creates and removes the pause file and reports the resulting state", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-central-focus-"));
		dirs.push(dir);
		const pauseFile = path.join(dir, "inbox-steer.paused");
		const commands = createCentralFocusCommands({ hqmsg: "", pauseFile, boardUrl: "https://board.example/" });
		expect(await commands.setPaused(true)).toBe(`Inbox steering paused (${pauseFile} exists)`);
		expect(await fs.exists(pauseFile)).toBe(true);
		expect(await commands.setPaused(true)).toContain("paused");
		expect(await commands.setPaused(false)).toBe(`Inbox steering running (${pauseFile} absent)`);
		expect(await fs.exists(pauseFile)).toBe(false);
	});

});
