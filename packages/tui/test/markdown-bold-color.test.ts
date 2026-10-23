import { afterAll, describe, expect, it } from "bun:test";
import { Markdown } from "../src/components/markdown";
import { loadTheme } from "../src/theme/loader";
import { getMarkdownTheme, initTheme, setThemeInstance } from "../src/theme/theme";

const LAVENDER = "\x1b[38;2;177;185;249m";
const HEADING = "\x1b[38;2;184;180;187m";

async function render(themeName: string, text: string): Promise<readonly string[]> {
	setThemeInstance(await loadTheme(themeName, { mode: "truecolor" }));
	return new Markdown(text, 0, 0, getMarkdownTheme()).render(80);
}

describe("markdown bold color", () => {
	afterAll(async () => {
		await initTheme();
	});

	it("colors bold text with mdBold in dark-claude", async () => {
		const row = (await render("dark-claude", "**SpriliCim:** plain text"))[0]!;
		expect(row).toContain(`${LAVENDER}SpriliCim:`);
		// The text after the bold span is not tinted.
		expect(row.slice(row.indexOf("SpriliCim:") + "SpriliCim:".length)).not.toContain(LAVENDER);
	});

	it("keeps headings in mdHeading in dark-claude, while inline bold stays mdBold", async () => {
		const rows = await render("dark-claude", "# Heading\n\nSome **x** text");
		const heading = rows.find(row => row.includes("Heading"))!;
		expect(heading).toContain(HEADING);
		expect(heading).not.toContain(LAVENDER);
		const body = rows.find(row => row.includes("Some"))!;
		expect(body).toMatch(/\x1b\[38;2;177;185;249m(\x1b\[1m)?x/);
	});

	it("leaves bold in the surrounding color for themes without mdBold", async () => {
		const row = (await render("dark", "**SpriliCim:** plain text"))[0]!;
		expect(row).not.toMatch(/\x1b\[38;[0-9;]+m(\x1b\[1m)?SpriliCim/);
	});
});
