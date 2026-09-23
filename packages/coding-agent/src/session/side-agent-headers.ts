/**
 * Request headers that link a side agent's provider traffic to the session it
 * serves.
 *
 * Side agents (advisors, task subagents, the memory extractor) talk to the
 * provider under their own provider session id, so a proxy sitting in front of
 * the provider cannot otherwise tell which main conversation a request belongs
 * to. These headers carry the parent's provider session id — the exact value
 * the parent agent sends as its own session id (`X-Claude-Code-Session-Id` for
 * Anthropic, `session_id` for OpenAI) — plus the side agent's role. The main
 * agent never sends them.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";

/** Provider session id of the session this side agent serves. */
export const PARENT_SESSION_ID_HEADER = "x-omp-parent-session-id";
/** Which kind of side agent issued the request. */
export const AGENT_ROLE_HEADER = "x-omp-agent-role";

export type SideAgentRole = "advisor" | "subagent" | "memory";

/** Build the side-agent headers, or `undefined` when there is no parent id to link. */
export function buildSideAgentHeaders(
	parentSessionId: string | undefined,
	role: SideAgentRole,
): Record<string, string> | undefined {
	if (!parentSessionId) return undefined;
	return { [PARENT_SESSION_ID_HEADER]: parentSessionId, [AGENT_ROLE_HEADER]: role };
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
