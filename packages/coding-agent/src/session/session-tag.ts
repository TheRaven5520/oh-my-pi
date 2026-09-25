/**
 * Tag-style session names: a one- or two-word ALL-CAPS label (e.g.
 * `SPRILICRED`, `PI05 EVALS`) that is renamed only when the conversation has
 * clearly and lastingly moved to different work.
 *
 * {@link SessionTagTracker} decides *when* to ask the title model whether the
 * tag still fits and *whether* to apply its answer; the caller does the asking.
 */

/** User prompts between tag checks, regardless of elapsed time. */
export const TAG_CHECK_EVERY_PROMPTS = 10;
/** A check also runs once this much time has passed, given a few new prompts. */
export const TAG_CHECK_EVERY_MS = 30 * 60_000;
/** Minimum new prompts before a time-based check; an idle session is never re-checked. */
export const TAG_CHECK_MIN_PROMPTS = 3;
/** Recent user messages a check reads. */
export const TAG_CHECK_CONTEXT_MESSAGES = 10;

const MAX_TAG_WORDS = 2;
const MAX_TAG_CHARS = 32;
const TAG_EDGE_PUNCTUATION = /^[.+&/-]+|[.+&/-]+$/g;

/**
 * Coerce a generated title into a tag: upper case, letters/digits plus
 * `. + & / -` inside words, at most two words. Returns null for anything that
 * is not already a tag in substance (empty, or three or more words), so the
 * caller keeps the current name instead of truncating a sentence.
 */
export function normalizeSessionTag(value: string | null | undefined): string | null {
	if (!value) return null;
	const words = value
		.toUpperCase()
		.replace(/[^A-Z0-9.+&/\-\s]/g, " ")
		.split(/\s+/)
		.map(word => word.replace(TAG_EDGE_PUNCTUATION, ""))
		.filter(Boolean);
	if (words.length === 0 || words.length > MAX_TAG_WORDS) return null;
	const tag = words.join(" ");
	return tag.length <= MAX_TAG_CHARS ? tag : null;
}

/** Whether `name` is already a tag (as opposed to a sentence title or empty). */
export function isSessionTag(name: string | undefined): name is string {
	return name !== undefined && normalizeSessionTag(name) === name;
}

/** Per-session cadence and hysteresis for tag checks. */
export class SessionTagTracker {
	#promptsSinceCheck = 0;
	#lastCheckAt: number;
	#changeProposed = false;

	constructor(now: number) {
		this.#lastCheckAt = now;
	}

	/** Count one user prompt; true when a tag check is due now. */
	notePrompt(now: number): boolean {
		this.#promptsSinceCheck++;
		const due =
			this.#promptsSinceCheck >= TAG_CHECK_EVERY_PROMPTS ||
			(this.#promptsSinceCheck >= TAG_CHECK_MIN_PROMPTS && now - this.#lastCheckAt >= TAG_CHECK_EVERY_MS);
		if (due) {
			this.#promptsSinceCheck = 0;
			this.#lastCheckAt = now;
		}
		return due;
	}

	/**
	 * Fold one check's answer into the decision. `proposed` is the normalized
	 * tag the model suggested, or null when it kept the current one. An unnamed
	 * session takes the first tag at once; any existing name, tag or sentence
	 * title, changes only after two consecutive checks propose a change, so a
	 * brief tangent or a run of status questions never renames the session.
	 * Returns the tag to apply, if any.
	 */
	resolve(current: string | undefined, proposed: string | null): string | undefined {
		if (!proposed || proposed === current) {
			this.#changeProposed = false;
			return undefined;
		}
		if (!current || this.#changeProposed) {
			this.#changeProposed = false;
			return proposed;
		}
		this.#changeProposed = true;
		return undefined;
	}
}
