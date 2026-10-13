import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { appendAdvisorNotes, createAdvisorMessageCard } from "@oh-my-pi/pi-tui/chat/advisor-message";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const darkTheme = await getThemeByName("dark");
if (!darkTheme) throw new Error("Failed to load dark theme");
setThemeInstance(darkTheme);

const concern = (note: string) => ({ note, severity: "concern" as const });
const blocker = (note: string) => ({ note, severity: "blocker" as const });

function rendered(card: ReturnType<typeof createAdvisorMessageCard>): string {
	return stripVTControlCharacters(card.render(120).join("\n"));
}

describe("advisor tail-note compression", () => {
	it("appends a consecutive non-blocking tail batch into the previous card", () => {
		const expanded = true;
		const card = createAdvisorMessageCard({ notes: [concern("first note")] }, () => expanded, darkTheme);

		expect(appendAdvisorNotes(card, [concern("second note")])).toBe(true);
		const text = rendered(card);

		expect(text).toContain("2 notes");
		expect(text).toContain("first note");
		expect(text).toContain("second note");
	});

	it("keeps blocker batches separate from the preceding non-blocking card", () => {
		const card = createAdvisorMessageCard({ notes: [concern("existing note")] }, () => true, darkTheme);

		expect(appendAdvisorNotes(card, [blocker("urgent blocker")])).toBe(false);
		expect(rendered(card)).not.toContain("urgent blocker");
	});

	it("does not append to an unrelated component", () => {
		expect(appendAdvisorNotes(undefined, [concern("late note")])).toBe(false);
	});
});
