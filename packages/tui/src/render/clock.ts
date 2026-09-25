/**
 * Wall-clock formatting for transcript timestamps and usage rows, in one
 * configurable IANA time zone (`display.timeZone`; unset = the process zone).
 * Formatters are cached per zone; daylight saving comes from the zone rules.
 */

let clockTimeZone: string | undefined;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(kind: "parts" | "zone"): Intl.DateTimeFormat {
	const key = `${kind}:${clockTimeZone ?? ""}`;
	let cached = formatters.get(key);
	if (!cached) {
		cached = new Intl.DateTimeFormat(
			"en-US",
			kind === "parts"
				? {
						timeZone: clockTimeZone,
						year: "numeric",
						month: "2-digit",
						day: "2-digit",
						hour: "2-digit",
						minute: "2-digit",
						second: "2-digit",
						hourCycle: "h23",
					}
				: { timeZone: clockTimeZone, timeZoneName: "short" },
		);
		formatters.set(key, cached);
	}
	return cached;
}

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

interface ClockParts {
	year: string;
	month: string;
	day: string;
	hour: string;
	minute: string;
	second: string;
}

function clockParts(ms: number): ClockParts {
	const parts: Record<string, string> = {};
	for (const part of formatter("parts").formatToParts(ms)) parts[part.type] = part.value;
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

/** Whether two instants fall on the same calendar day in the configured zone. */
export function isSameClockDay(a: number, b: number): boolean {
	const x = clockParts(a);
	const y = clockParts(b);
	return x.year === y.year && x.month === y.month && x.day === y.day;
}

/** Short zone label at `ms` (e.g. `EDT`, `UTC`). */
export function clockZoneLabel(ms: number = Date.now()): string {
	return (
		formatter("zone")
			.formatToParts(ms)
			.find(part => part.type === "timeZoneName")?.value ?? ""
	);
}
