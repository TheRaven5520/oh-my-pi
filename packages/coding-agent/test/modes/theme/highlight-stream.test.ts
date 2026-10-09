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
	it("renders a streaming lua fence without aborting", () => {
		const markdown = new Markdown("```lua\nlocal x = 1\nmore", 0, 0, getMarkdownTheme());
		markdown.transientRenderCache = true;
		let lines: readonly string[] = [];
		expect(() => {
			lines = markdown.render(80);
		}).not.toThrow();
		const plain = stripVTControlCharacters(lines.join("\n"));
		expect(plain).toContain("local x = 1");
	});

	it("keeps code-block color on grammar-less fences once they close", () => {
		for (const fence of ["```text", "```"]) {
			const closed = new Markdown(`${fence}\nBase checkpoint:\n${"```"}\n`, 0, 0, getMarkdownTheme()).render(80);
			const body = closed.find(line => line.includes("Base checkpoint:"));
			expect(body).toContain(theme.fg("mdCodeBlock", "Base checkpoint:"));

			const streaming = new Markdown(`${fence}\nBase checkpoint:\nmore`, 0, 0, getMarkdownTheme());
			streaming.transientRenderCache = true;
			expect(streaming.render(80).find(line => line.includes("Base checkpoint:"))).toBe(body);
		}
	});
});
