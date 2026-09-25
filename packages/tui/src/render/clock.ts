/**
 * Wall-clock formatting for every time omp shows, in one configurable IANA
 * time zone (`display.timeZone`; unset = the process zone). Formatters are
 * cached per zone; daylight saving comes from the zone rules.
 */

let clockTimeZone: string | undefined;
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * An `en-US` formatter for `options` in the configured zone. Cached per zone
 * and options, so call it at format time rather than holding the result.
 */
export function clockDateTimeFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${clockTimeZone ?? ""}|${JSON.stringify(options)}`;
	let cached = formatters.get(key);
	if (!cached) {
		cached = new Intl.DateTimeFormat("en-US", { ...options, timeZone: clockTimeZone });
		formatters.set(key, cached);
	}
	return cached;
}

const PARTS_OPTIONS: Intl.DateTimeFormatOptions = {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
};

/**
 * Use `zone` (an IANA name such as `America/New_York`) for every clock time;
 * empty or undefined means the process zone. Returns false, keeping the
 * current zone, when `zone` is not a valid IANA name.
 */
export function setClockTimeZone(zone: string | undefined): boolean {
	const next = zone?.trim() || undefined;
	if (next !== undefined) {
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: next });
		} catch {
			return false;
		}
	}
	clockTimeZone = next;
	return true;
}

/** The configured IANA zone, or undefined for the process zone. */
export function getClockTimeZone(): string | undefined {
	return clockTimeZone;
}

/** Calendar and clock fields of an instant in the configured zone (zero-padded). */
export interface ClockParts {
	year: string;
	month: string;
	day: string;
	hour: string;
	minute: string;
	second: string;
}

export function clockParts(ms: number): ClockParts {
	const parts: Record<string, string> = {};
	for (const part of clockDateTimeFormat(PARTS_OPTIONS).formatToParts(ms)) parts[part.type] = part.value;
	return {
		year: parts.year ?? "",
		month: parts.month ?? "",
		day: parts.day ?? "",
		hour: parts.hour ?? "",
		minute: parts.minute ?? "",
		second: parts.second ?? "",
	};
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `HH:MM:SS`, or `Mon D HH:MM:SS` with `withDate`. */
export function formatClockTime(ms: number, options: { withDate?: boolean } = {}): string {
	const p = clockParts(ms);
	const time = `${p.hour}:${p.minute}:${p.second}`;
	if (!options.withDate) return time;
	return `${MONTHS[Number(p.month) - 1] ?? p.month} ${Number(p.day)} ${time}`;
}

/** `YYYY-MM-DD HH:MM:SS`. */
export function formatClockDateTime(ms: number): string {
	const p = clockParts(ms);
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** `YYYY-MM-DD`. */
export function formatClockDate(ms: number): string {
	const p = clockParts(ms);
	return `${p.year}-${p.month}-${p.day}`;
}

/** Numeric UTC offset at `ms`, e.g. `-04:00` (`+00:00` for UTC). */
export function clockUtcOffset(ms: number): string {
	const name =
		clockDateTimeFormat({ timeZoneName: "longOffset" })
			.formatToParts(ms)
			.find(part => part.type === "timeZoneName")?.value ?? "";
	const match = /^GMT([+-]\d{2}:\d{2})$/.exec(name);
	return match ? match[1]! : "+00:00";
}

/** Whether two instants fall on the same calendar day in the configured zone. */
export function isSameClockDay(a: number, b: number): boolean {
	const x = clockParts(a);
	const y = clockParts(b);
	return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** Short zone label at `ms` (e.g. `EDT`, `UTC`). */
export function clockZoneLabel(ms: number = Date.now()): string {
	return (
		clockDateTimeFormat({ timeZoneName: "short" })
			.formatToParts(ms)
			.find(part => part.type === "timeZoneName")?.value ?? ""
	);
}
