import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { getMarkdownTheme, getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

describe("markdown highlight stream", () => {
	it("renders a streaming lua fence without aborting or showing delimiters", () => {
		const markdown = new Markdown("```lua\nlocal x = 1\nmore", 0, 0, getMarkdownTheme());
		markdown.transientRenderCache = true;
		let lines: readonly string[] = [];
		expect(() => {
			lines = markdown.render(80);
		}).not.toThrow();
		const plain = stripVTControlCharacters(lines.join("\n"));
		expect(plain).toContain("local x = 1");
		expect(plain).not.toContain("```lua");
	});

	it("renders no fence rows for language or bare fences, streaming or closed", () => {
		for (const fence of ["```text", "```yaml", "```"]) {
			const closed = new Markdown(`${fence}\nBase checkpoint:\n${"```"}\n`, 0, 0, getMarkdownTheme()).render(80);
			const streaming = new Markdown(`${fence}\nBase checkpoint:\nmore`, 0, 0, getMarkdownTheme());
			streaming.transientRenderCache = true;
			const open = streaming.render(80);
			for (const lines of [closed, open]) {
				expect(lines.map(line => stripVTControlCharacters(line)).filter(line => line.includes("```"))).toEqual([]);
				// The code body is the first row: nothing replaced the hidden fence.
				expect(stripVTControlCharacters(lines[0]!)).toContain("Base checkpoint:");
			}
			const body = closed[0]!;
			// Grammar-less fences keep the code-block color; yaml highlights its own tokens.
			if (fence !== "```yaml") expect(body).toContain(theme.fg("mdCodeBlock", "Base checkpoint:"));
			// Streaming and closed rows agree, so the block does not jump when the fence closes.
			expect(open[0]).toBe(body);
		}
	});

	it("keeps a citation info string as the only header row", () => {
		const lines = new Markdown("```12:30:src/app.ts\nconst a = 1;\n```\n", 0, 0, getMarkdownTheme())
			.render(80)
			.map(line => stripVTControlCharacters(line).trimEnd());
		expect(lines[0]).toBe("12:30:src/app.ts");
		expect(lines[1]).toContain("const a = 1;");
		expect(lines.filter(line => line.includes("```"))).toEqual([]);
	});
});
