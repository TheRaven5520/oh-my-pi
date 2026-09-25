import { clockParts, clockUtcOffset, formatClockDate } from "../render/clock";

/** YYYY-MM-DD in the display time zone (`display.timeZone`; the process zone when unset). */
export function formatLocalCalendarDate(date: Date = new Date()): string {
	return formatClockDate(date.getTime());
}

/** `YYYY-MM-DD HH:MM ±HH:MM` in the display time zone, with its UTC offset at that instant. */
export function formatLocalDateTimeWithOffset(date: Date): string {
	const ms = date.getTime();
	const p = clockParts(ms);
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${clockUtcOffset(ms)}`;
}
