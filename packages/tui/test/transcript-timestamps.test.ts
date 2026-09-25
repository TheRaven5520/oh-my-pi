import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer, type TranscriptStableRow } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { stampRow } from "@oh-my-pi/pi-tui/chrome/transcript-stamp";
import { formatLocalCalendarDate, formatLocalDateTimeWithOffset } from "@oh-my-pi/pi-tui/chrome/local-date";
import {
	clockDateTimeFormat,
	clockUtcOffset,
	clockZoneLabel,
	formatClockDateTime,
	formatClockTime,
	isSameClockDay,
	setClockTimeZone,
} from "@oh-my-pi/pi-tui/render/clock";
import { SEGMENTS } from "@oh-my-pi/pi-tui/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-tui/status-line/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";

const frame = { tick: 0, now: 0 };
const plain = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row));
const count = (text: string, needle: string) => text.split(needle).length - 1;

class Block implements Component {
	constructor(
		private rows: string[],
		private finalized = false,
	) {}
	finalize(): void {
		this.finalized = true;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
	render(): readonly string[] {
		return this.rows;
	}
}

class StreamingBlock implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	#rows: string[] = [];
	#finalized = false;
	stream(rows: string[]): void {
		this.#rows = rows;
	}
	finalize(): void {
		this.#finalized = true;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}
	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		// Every row but the last (still growing) is stable, as a streaming reply publishes.
		return this.#rows.slice(0, this.#finalized ? this.#rows.length : -1).map(key => ({ key }));
	}
	renderTranscriptStableRows(count: number): readonly string[] {
		return this.#rows.slice(0, count);
	}
	render(): readonly string[] {
		return this.#rows;
	}
}

/** A reply that publishes every row as it streams, the last one included. */
class EagerStreamingBlock extends StreamingBlock {
	override getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.render().map(key => ({ key }));
	}
}

/** A reply that never publishes its last row, even once finalized (e.g. a trailing status line). */
class HeldTailBlock extends StreamingBlock {
	override getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.render()
			.slice(0, -1)
			.map(key => ({ key }));
	}
}

/** The label a block started at `at` shows (with the date when it is not today). */
const startLabel = (at: number) => formatClockTime(at, { withDate: !isSameClockDay(at, Date.now()) });

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setChatTranscriptDisplayPreferences({ showTimestamps: false });
	setClockTimeZone(undefined);
});

describe("stampRow", () => {
	it("writes the label into a tinted user row's padding without touching content or shell markers", () => {
		const row = new UserMessageComponent("fix the parser please").render(80)[0]!;
		const stamped = stampRow(row, 80, "12:03:15", 8)!;

		expect(visibleWidth(stamped)).toBe(visibleWidth(row));
		expect(Bun.stripANSI(stamped).trimEnd().endsWith("fix the parser please          12:03:15".slice(-8))).toBe(true);
		expect(count(stamped, "\x1b]133;A")).toBe(1);
		expect(count(stamped, "\x1b]133;D")).toBe(count(row, "\x1b]133;D"));
		// Everything up to the end of the text is byte-identical.
		const textEnd = row.indexOf("please") + "please".length;
		expect(stamped.slice(0, textEnd)).toBe(row.slice(0, textEnd));
		// Right-aligned, one column in from the edge.
		expect(Bun.stripANSI(stamped).indexOf("12:03:15")).toBe(80 - 1 - 8);
		// Still on the tinted band: the background is open where the label starts.
		const before = stamped.slice(0, stamped.indexOf("12:03:15"));
		expect(before.lastIndexOf("\x1b[48;")).toBeGreaterThan(before.lastIndexOf("\x1b[49m"));
	});

	it("keeps a hyperlink that ends the content intact", () => {
		const link = "\x1b]8;;https://example.com\x1b\\docs\x1b]8;;\x1b\\";
		const row = `see ${link}${" ".repeat(20)}`;
		const stamped = stampRow(row, 60, "12:03:15", 8)!;
		expect(stamped.startsWith(`see ${link}`)).toBe(true);
		expect(count(stamped, "\x1b]8;;")).toBe(2);
		expect(visibleWidth(stamped)).toBe(60 - 1);
	});

	it("appends to an unpadded row and leaves a row with no room alone", () => {
		expect(Bun.stripANSI(stampRow("● bash ls", 40, "12:03:15", 8)!)).toBe(
			`● bash ls${" ".repeat(40 - 1 - 8 - 9)}12:03:15`,
		);
		expect(stampRow("x".repeat(35), 40, "12:03:15", 8)).toBeUndefined();
	});

	it("writes inside a full-width card's right border, keeping the border and its color", () => {
		const border = "\x1b[38;5;243m│\x1b[39m";
		const row = `${border} $ sleep 6${" ".repeat(28)}${border}`;
		const stamped = stampRow(row, 40, "\x1b[2m12:03:15\x1b[22m", 8)!;
		expect(Bun.stripANSI(stamped)).toBe(`│ $ sleep 6${" ".repeat(19)}12:03:15 │`);
		expect(stamped.endsWith(` ${border}`)).toBe(true);
		expect(visibleWidth(stamped)).toBe(40);
		// The top border has no padding, and a narrow box (a table) is content.
		expect(stampRow(`╭${"─".repeat(38)}╮`, 40, "12:03:15", 8)).toBeUndefined();
		const table = `│ a │ b${" ".repeat(20)}│`;
		expect(Bun.stripANSI(stampRow(table, 40, "12:03:15", 8)!)).toBe(`${table}${" ".repeat(3)}12:03:15`);
	});
});

describe("TranscriptContainer timestamps", () => {
	it("labels stamped blocks only while timestamps are on", () => {
		const transcript = new TranscriptContainer();
		const at = Date.now() - 5_000;
		transcript.addChild(new Block(["❯ hello"]));
		transcript.stampBlockTime(transcript.children[0]!, at);

		// Off: byte-identical to an unstamped block.
		expect(transcript.renderViewport(60, 10, frame)).toEqual(["❯ hello"]);
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		const [row] = plain(transcript.renderViewport(60, 10, frame));
		expect(row!.startsWith("❯ hello")).toBe(true);
		expect(row!.endsWith(`${startLabel(at)} `) || row!.endsWith(startLabel(at))).toBe(true);
	});

	it("adds a finished step's duration before the block commits", () => {
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		const transcript = new TranscriptContainer();
		const tool = new Block(["● bash sleep 3", "  done"]);
		transcript.addChild(tool);
		const at = Date.now() - 10_000;
		transcript.stampBlockTime(tool, at);
		expect(plain(transcript.renderViewport(60, 10, frame))[0]).toContain(startLabel(at));
		expect(plain(transcript.renderViewport(60, 10, frame))[0]).not.toContain("·");

		transcript.stampBlockEnd(tool, at + 3_200);
		tool.finalize();
		const committed = transcript.peekFinalizedBatch(60, 0)!;
		expect(Bun.stripANSI(committed.rows[0]!)).toContain(`${startLabel(at)} · 3.2s`);
		// What went to scrollback is exactly what a fresh render shows.
		expect(committed.rows.slice(0, 2)).toEqual(transcript.render(60).slice(0, 2));
	});

	it("labels a streaming reply's next row when its first row is full, without freezing publication", () => {
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		const transcript = new TranscriptContainer();
		const reply = new StreamingBlock();
		transcript.addChild(reply);
		const at = Date.now() - 2_000;
		transcript.stampBlockTime(reply, at);
		const full = "w".repeat(59);
		reply.stream([full, "partial"]);

		const first = transcript.peekFinalizedBatch(60, 1)!;
		expect(first.rows).toEqual([full]);
		transcript.acknowledgeFinalizedBatch(first.id);
		reply.stream([full, "short", "partial"]);
		const second = transcript.peekFinalizedBatch(60, 1)!;
		expect(plain(second.rows)[0]).toContain(startLabel(at));
		expect(plain(second.rows)[0]!.startsWith("short")).toBe(true);
		transcript.acknowledgeFinalizedBatch(second.id);
		reply.stream([full, "short", "", "next", "partial"]);
		expect(plain(transcript.peekFinalizedBatch(60, 1)!.rows)).toEqual(["", "next"]);
	});

	it("puts the label on the first content row with room, never on a blank separator", () => {
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		const transcript = new TranscriptContainer();
		const block = new Block(["w".repeat(59), "", "● body"]);
		transcript.addChild(block);
		const at = Date.now() - 1_000;
		transcript.stampBlockTime(block, at);
		const rows = plain(transcript.render(60));
		expect(rows[1]).toBe("");
		expect(rows[2]!.startsWith("● body")).toBe(true);
		expect(rows[2]).toContain(startLabel(at));
	});

	it("keeps a block's time when a rebuild moves it from a staging container into the visible one", () => {
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		const staged = new TranscriptContainer();
		const visible = new TranscriptContainer();
		const block = new Block(["● read notes.txt"]);
		staged.addChild(block);
		const at = Date.now() - 1_000;
		staged.stampBlockTime(block, at, { end: at + 250 });
		staged.clear();
		visible.addChild(block);
		expect(plain(visible.render(60))[0]).toEndWith(`${startLabel(at)} · 250ms`);
	});

	it("drops the cached clock text when a block is stamped again after a zone change", () => {
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		setClockTimeZone("UTC");
		const transcript = new TranscriptContainer();
		const block = new Block(["● read notes.txt"]);
		transcript.addChild(block);
		const at = Date.now() - 1_000;
		transcript.stampBlockTime(block, at);
		expect(plain(transcript.render(60))[0]).toContain(startLabel(at));

		setClockTimeZone("Asia/Kolkata");
		expect(plain(transcript.render(60))[0]).not.toContain(startLabel(at));
		transcript.stampBlockTime(block, at);
		expect(plain(transcript.render(60))[0]).toContain(startLabel(at));
	});

	it("stamps a streaming reply's first row identically in every path, so publication never freezes", () => {
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		const transcript = new TranscriptContainer();
		const reply = new StreamingBlock();
		transcript.addChild(reply);
		const at = Date.now() - 2_000;
		transcript.stampBlockTime(reply, at);
		reply.stream(["The answer is", "partial"]);

		const first = transcript.peekFinalizedBatch(60, 1)!;
		expect(plain(first.rows)[0]).toContain(startLabel(at));
		transcript.acknowledgeFinalizedBatch(first.id);

		// A frozen block offers no further mid-stream rows; this one keeps publishing.
		reply.stream(["The answer is", "forty two", "partial"]);
		const second = transcript.peekFinalizedBatch(60, 1);
		expect(second === undefined ? undefined : plain(second.rows)).toEqual(["forty two"]);
		transcript.acknowledgeFinalizedBatch(second!.id);
		// Once the reply ends, its duration goes on the last row, which was never
		// published: the emitted rows stay byte-identical, so finalizing retires
		// only the tail instead of freezing and repeating the block.
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			transcript.stampBlockEnd(reply, at + 5_000);
			reply.finalize();
			expect(transcript.render(60)[0]).toBe(first.rows[0]);
			const tail = transcript.peekFinalizedBatch(60, 0);
			expect(tail === undefined ? undefined : plain(tail.rows)).toEqual([`partial${" ".repeat(48)}5.0s`]);
			expect(warn).not.toHaveBeenCalledWith("Append-only transcript block frozen", expect.anything());
		} finally {
			warn.mockRestore();
		}
	});

	it("leaves out a reply's duration when its last row was already published, until a display reset", () => {
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		const transcript = new TranscriptContainer();
		const reply = new EagerStreamingBlock();
		transcript.addChild(reply);
		const at = Date.now() - 2_000;
		transcript.stampBlockTime(reply, at);
		reply.stream(["The answer is", "forty two"]);
		const published = transcript.peekFinalizedBatch(60, 0)!;
		expect(plain(published.rows)).toHaveLength(2);
		transcript.acknowledgeFinalizedBatch(published.id);

		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			transcript.stampBlockEnd(reply, at + 5_000);
			reply.finalize();
			expect(transcript.render(60)).toEqual(published.rows);
			expect(warn).not.toHaveBeenCalledWith("Append-only transcript block frozen", expect.anything());
		} finally {
			warn.mockRestore();
		}

		// A display reset clears scrollback, so the whole reply renders afresh.
		transcript.resetStableEmission();
		expect(plain(transcript.render(60))[1]).toBe(`forty two${" ".repeat(46)}5.0s`);
	});

	it("places a reply's duration by its full render, even when its published rows stop short", () => {
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		const transcript = new TranscriptContainer();
		const reply = new HeldTailBlock();
		transcript.addChild(reply);
		const at = Date.now() - 2_000;
		transcript.stampBlockTime(reply, at, { end: at + 5_000 });
		reply.stream(["The answer is", "forty two", "(stopped)"]);
		reply.finalize();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const rows = plain(transcript.renderViewport(60, 10, frame));
			expect(rows[1]).toBe("forty two");
			expect(rows[2]).toBe(`(stopped)${" ".repeat(46)}5.0s`);
			expect(warn).not.toHaveBeenCalledWith("Append-only transcript block frozen", expect.anything());
		} finally {
			warn.mockRestore();
		}
	});

	it("puts a one-row reply's start and duration together", () => {
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		const transcript = new TranscriptContainer();
		const reply = new StreamingBlock();
		transcript.addChild(reply);
		const at = Date.now() - 2_000;
		transcript.stampBlockTime(reply, at, { end: at + 41_000 });
		reply.stream(["Done."]);
		reply.finalize();
		expect(plain(transcript.render(60))[0]).toEndWith(`${startLabel(at)} · 41.0s`);
	});

	it("counts a running step up in whole seconds, then shows its exact duration", () => {
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		const transcript = new TranscriptContainer();
		const tool = new Block(["● bash sleep 5"]);
		const idle = new Block(["● read notes.txt"]);
		transcript.addChild(tool);
		transcript.addChild(idle);
		const at = Date.now() - 3_500;
		transcript.stampBlockTime(tool, at, { running: true });
		transcript.stampBlockTime(idle, at);
		const [running, , notRunning] = plain(transcript.render(60));
		expect(running).toEndWith(`${startLabel(at)} · 3s`);
		expect(notRunning).toEndWith(startLabel(at));

		transcript.stampBlockEnd(tool, at + 3_200);
		expect(plain(transcript.render(60))[0]).toEndWith(`${startLabel(at)} · 3.2s`);
	});
});

describe("clock", () => {
	const instant = Date.UTC(2026, 0, 15, 17, 3, 15); // 12:03:15 EST
	const summer = Date.UTC(2026, 6, 15, 16, 3, 15); // 12:03:15 EDT

	it("formats in the configured IANA zone, daylight saving included", () => {
		expect(setClockTimeZone("America/New_York")).toBe(true);
		expect(formatClockTime(instant)).toBe("12:03:15");
		expect(formatClockTime(summer)).toBe("12:03:15");
		expect(formatClockTime(instant, { withDate: true })).toBe("Jan 15 12:03:15");
		expect(formatClockDateTime(summer)).toBe("2026-07-15 12:03:15");
		expect(clockZoneLabel(instant)).toBe("EST");
		expect(clockZoneLabel(summer)).toBe("EDT");
		expect(formatClockTime(Date.UTC(2026, 0, 15, 5, 0, 5))).toBe("00:00:05");
	});

	it("rejects an unknown zone and keeps the previous one", () => {
		setClockTimeZone("UTC");
		expect(setClockTimeZone("Mars/Olympus_Mons")).toBe(false);
		expect(formatClockTime(instant)).toBe("17:03:15");
	});

	it("gives every other clock the same zone: offsets, dates, formatters and the status-line time", () => {
		setClockTimeZone("America/New_York");
		expect(clockUtcOffset(instant)).toBe("-05:00");
		expect(clockUtcOffset(summer)).toBe("-04:00");
		expect(formatLocalDateTimeWithOffset(new Date(summer))).toBe("2026-07-15 12:03 -04:00");
		// 00:30 UTC on Jul 16 is still Jul 15 in New York.
		expect(formatLocalCalendarDate(new Date(Date.UTC(2026, 6, 16, 0, 30)))).toBe("2026-07-15");
		const hhmm: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
		expect(clockDateTimeFormat(hhmm).format(summer)).toBe("12:03");
		const statusTime = (format?: "12h") =>
			Bun.stripANSI(
				SEGMENTS.time.render({
					options: { time: { format, showSeconds: true } },
					now: new Date(summer),
				} as unknown as SegmentContext).content,
			);
		expect(statusTime()).toEndWith("12:03:15");
		expect(statusTime("12h")).toEndWith("12:03:15pm");

		setClockTimeZone("UTC");
		expect(clockUtcOffset(summer)).toBe("+00:00");
		expect(clockDateTimeFormat(hhmm).format(summer)).toBe("16:03");
		expect(statusTime()).toEndWith("16:03:15");
	});
});
