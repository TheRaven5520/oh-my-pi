import { afterEach, describe, expect, it } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { getThemeByName, setThemeInstance, theme, type Theme } from "@oh-my-pi/pi-tui/theme";

let originalTheme: Theme | undefined;
afterEach(() => {
	if (originalTheme) setThemeInstance(originalTheme);
	originalTheme = undefined;
});

describe("UserMessageComponent theme invalidation", () => {
	it("recolors cached markdown in an accepted message after a theme change", async () => {
		const dark = await getThemeByName("dark");
		const light = await getThemeByName("light");
		if (!dark || !light) throw new Error("Expected dark and light themes to exist");
		originalTheme = theme ?? dark;
		setThemeInstance(dark);
		const message = new UserMessageComponent("Please review `parser`.");
		message.setAwaitingModel(true);
		message.render(80);
		message.setAwaitingModel(false);
		const before = message.render(80).join("\n");
		const darkCode = theme.getFgAnsi("mdCode");
		expect(before).toContain(`${darkCode}parser`);

		setThemeInstance(light);
		const lightCode = theme.getFgAnsi("mdCode");
		expect(lightCode).not.toBe(darkCode);
		message.invalidate();
		const after = message.render(80).join("\n");
		expect(after).toContain(`${lightCode}parser`);
		expect(after).not.toContain(`${darkCode}parser`);
		expect(Bun.stripANSI(after)).toBe(Bun.stripANSI(before));
	});
});
