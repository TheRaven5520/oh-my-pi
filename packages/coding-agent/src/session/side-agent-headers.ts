/**
 * Request headers that link a side request's provider traffic to the session it
 * serves.
 *
 * Side requests talk to the provider under their own provider session id, a
 * derived one (`<id>:side:<n>`), or none at all, so a proxy sitting in front of
 * the provider cannot otherwise tell which conversation a request belongs to.
 * Side requests that do not send the chat's own provider session id therefore
 * carry these headers: the parent's provider session id — the exact value the
 * parent agent sends as its own session id (`X-Claude-Code-Session-Id` for
 * Anthropic, `session_id` for OpenAI) — plus the request's role:
 *
 * - `subagent`: task subagents, clones (`/tan`, `/fork`), vibe workers and
 *   security scan sessions — their main requests, side requests, and the
 *   auto-thinking judge that can precede their first request.
 * - `fresh`: a top-level session's own main requests (and judge) while `/fresh`
 *   or reset-context has swapped in a provider session id nothing links to the
 *   chat; the parent is the id the chat is otherwise sent under.
 * - `advisor`, `memory`: advisors and the memory extractor.
 * - `title`, `label`: session titles and subagent UI labels.
 * - `capture`: the auto-learn capture turn.
 * - `summary`: branch summaries.
 * - `helper`: one-shot helpers (image questions, vision fallback, eval
 *   completions) and side turns such as `/btw` and the idle recap.
 * - `judge`, `security`: reserved.
 *
 * Otherwise a top-level session's own main requests send none: their session
 * id already names the chat.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";

/** Provider session id of the session this side agent serves. */
export const PARENT_SESSION_ID_HEADER = "x-omp-parent-session-id";
/** Which kind of side agent issued the request. */
export const AGENT_ROLE_HEADER = "x-omp-agent-role";

export type SideAgentRole =
	| "advisor"
	| "subagent"
	| "memory"
	| "title"
	| "label"
	| "capture"
	| "helper"
	| "judge"
	| "summary"
	| "security"
	| "fresh";

/** Build the side-agent headers, or `undefined` when there is no parent id to link. */
export function buildSideAgentHeaders(
	parentSessionId: string | undefined,
	role: SideAgentRole,
): Record<string, string> | undefined {
	if (!parentSessionId) return undefined;
	return { [PARENT_SESSION_ID_HEADER]: parentSessionId, [AGENT_ROLE_HEADER]: role };
}

/**
 * Link headers for a session's own main-agent requests and the auto-thinking
 * judge that can precede them: a spawned session names its spawner
 * (`subagent`); a top-level session names its chat (`fresh`) only while a
 * `/fresh` provider session id is active; otherwise none.
 */
export function buildMainAgentLinkHeaders(
	parentProviderSessionId: string | undefined,
	freshParentSessionId: string | undefined,
): Record<string, string> | undefined {
	if (parentProviderSessionId) return buildSideAgentHeaders(parentProviderSessionId, "subagent");
	return buildSideAgentHeaders(freshParentSessionId, "fresh");
}

/** Return `options` with the side-agent headers merged over any caller headers. */
export function withSideAgentHeaders<T extends SimpleStreamOptions>(
	options: T | undefined,
	parentSessionId: string | undefined,
	role: SideAgentRole,
): T | undefined {
	const headers = buildSideAgentHeaders(parentSessionId, role);
	if (!headers) return options;
	return { ...options, headers: { ...options?.headers, ...headers } } as T;
}

/**
 * Wrap a stream function so every request carries the side-agent headers. The
 * parent id is read per request so it follows the parent across conversation
 * boundaries (`/new`, session switch, fresh provider sessions).
 */
export function wrapStreamFnWithSideAgentHeaders(
	streamFn: StreamFn,
	getParentSessionId: () => string | undefined,
	role: SideAgentRole,
): StreamFn {
	return (model, context, options) =>
		streamFn(model, context, withSideAgentHeaders(options, getParentSessionId(), role));
}
