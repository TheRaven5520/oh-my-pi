import { describe, expect, it } from "bun:test";
import { generateThemeStyles, generateThemeVars, parseExportArgs } from "@oh-my-pi/pi-coding-agent/export/html";

describe("HTML export themes", () => {
	it("bundles dark, light, and auto-following web themes", async () => {
		const styles = await generateThemeStyles("web");

		expect(styles).toContain(':root, :root[data-theme="dark"] { color-scheme: dark;');
		expect(styles).toContain(':root[data-theme="light"] { color-scheme: light;');
		expect(styles).toContain("@media (prefers-color-scheme: light)");
		expect(styles).toContain("--bg: #0f0b14;");
		expect(styles).toContain("--bg: oklch(0.985 0.004 307);");
	});

	it("bundles independently selected dark and light TUI themes", async () => {
		const [styles, dark, light] = await Promise.all([
			generateThemeStyles("theme", { dark: "titanium", light: "light" }),
			generateThemeVars("theme", "titanium"),
			generateThemeVars("theme", "light"),
		]);

		expect(styles).toContain(`:root, :root[data-theme="dark"] { color-scheme: dark; ${dark} }`);
		expect(styles).toContain(`:root[data-theme="light"] { color-scheme: light; ${light} }`);
	});

	it("colors bold with mdBold and declares it in every theme variant", async () => {
		const [claude, light, css] = await Promise.all([
			generateThemeVars("theme", "dark-claude"),
			generateThemeVars("theme", "light"),
			Bun.file(new URL("../src/export/html/template.css", import.meta.url)).text(),
		]);

		expect(claude).toContain("--mdBold: #b1b9f9;");
		// A theme without mdBold resets it, so dark-claude's lavender cannot leak into the light variant.
		expect(light).toContain("--mdBold: currentColor;");
		expect(css).toContain(".markdown-content strong { color: var(--mdBold, currentColor); }");
	});

	it("parses the optional user-theme flag before or after the output path", () => {
		expect(parseExportArgs("--themes export.html")).toEqual({ outputPath: "export.html", useUserThemes: true });
		expect(parseExportArgs("export.html --themes")).toEqual({ outputPath: "export.html", useUserThemes: true });
		expect(parseExportArgs("")).toEqual({ outputPath: undefined, useUserThemes: false });
		expect(() => parseExportArgs("one.html two.html")).toThrow("Usage: /export [--themes] [path]");
	});
});
