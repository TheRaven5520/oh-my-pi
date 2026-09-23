import { beforeAll, describe, expect, it } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

const WIDTH = 40;

beforeAll(async () => {
	await initTheme(false);
});

function rows(component: UserMessageComponent): string[] {
	return component.render(WIDTH).map(row => Bun.stripANSI(row));
}

describe("UserMessageComponent layout", () => {
	it("starts with the pointer, adds no padding rows, and indents wrapped lines under the text", () => {
		const component = new UserMessageComponent(
			"a prompt long enough that it has to wrap onto more than one row of the transcript",
		);
		const lines = rows(component);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toStartWith("❯ a prompt");
		for (const line of lines.slice(1)) expect(line).toMatch(/^ {2}\S/);
		for (const line of lines) expect(Bun.stringWidth(line)).toBe(WIDTH);
	});

	it("puts a reaction at the end of the first row without adding rows", () => {
		const component = new UserMessageComponent("ship it?");
		const plain = rows(component);
		component.setReaction("🚀");
		const reacted = rows(component);

		expect(reacted).toHaveLength(plain.length);
		expect(reacted[0]).toStartWith("❯ ship it?");
		expect(reacted[0]).toEndWith("🚀 ");
		for (const line of reacted) expect(Bun.stringWidth(line)).toBe(WIDTH);
	});

	it("draws the text dim while awaiting the model and restores it afterwards", () => {
		const component = new UserMessageComponent("hello");
		const normal = component.render(WIDTH).join("\n");

		component.setAwaitingModel(true);
		const awaiting = component.render(WIDTH).join("\n");
		expect(awaiting).toContain(`${theme.getFgAnsi("dim")}hello`);
		expect(Bun.stripANSI(awaiting)).toBe(Bun.stripANSI(normal));

		component.setAwaitingModel(false);
		expect(component.render(WIDTH).join("\n")).toBe(normal);
	});
});
