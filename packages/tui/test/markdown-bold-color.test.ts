import { afterAll, describe, expect, it } from "bun:test";
import { Markdown } from "../src/components/markdown";
import { loadTheme } from "../src/theme/loader";
import { getMarkdownTheme, initTheme, setThemeInstance } from "../src/theme/theme";

const LAVENDER = "\x1b[38;2;177;185;249m";

async function renderBold(themeName: string): Promise<string> {
	setThemeInstance(await loadTheme(themeName, { mode: "truecolor" }));
	return new Markdown("**SpriliCim:** plain text", 0, 0, getMarkdownTheme()).render(80)[0]!;
}

describe("markdown bold color", () => {
	afterAll(async () => {
		await initTheme();
	});

	it("colors bold text with mdBold in dark-claude", async () => {
		const row = await renderBold("dark-claude");
		expect(row).toContain(`${LAVENDER}SpriliCim:`);
		// The text after the bold span is not tinted.
		expect(row.slice(row.indexOf("SpriliCim:") + "SpriliCim:".length)).not.toContain(LAVENDER);
	});

	it("leaves bold in the surrounding color for themes without mdBold", async () => {
		const row = await renderBold("dark");
		expect(row).not.toMatch(/\x1b\[38;[0-9;]+m(\x1b\[1m)?SpriliCim/);
	});
});
