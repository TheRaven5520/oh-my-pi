import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentRegistry, type AgentRef, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { CreateAgentSessionOptions } from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import { createMCPProxyTools, createSubagentSettings } from "../../task/executor";
import type { InteractiveModeContext } from "../types";

/** Per-clone identity passed to {@link SessionCloneParent.sessionOptions}. */
export interface SessionCloneIdentity {
	sessionManager: SessionManager;
	agentId: string;
	displayName: string;
	providerSessionId: string;
	/** Revival CAS: the parked ref a reviver is authorized to reclaim. */
	expectedAgentRef?: AgentRef | null;
	/** Clone-only tools added on top of the parent's MCP proxies. */
	extraTools?: CustomTool[];
}

/**
 * Parent state a session clone (`/tan`, `/fork`) inherits, captured once at
 * dispatch. The interactive SessionManager is mutable and may switch
 * transcripts while the clone lives, so nothing here reads the parent lazily.
 */
export interface SessionCloneParent {
	readonly model: NonNullable<AgentSession["model"]>;
	readonly parentSessionId: string;
	readonly ownerId: string;
	/** Clones nest inside the parent's artifact directory, like subagents, and share its artifacts in place. */
	readonly cloneDir: string;
	cloneFile(agentId: string): string;
	/** Copy the parent transcript into `cloneFile`, ready for a fresh agent. */
	forkTranscript(cloneFile: string): Promise<SessionManager>;
	sessionOptions(identity: SessionCloneIdentity): CreateAgentSessionOptions;
}

/** Snapshot the parent session for cloning. Callers validate model and persistence first. */
export function captureSessionCloneParent(
	ctx: InteractiveModeContext,
	model: NonNullable<AgentSession["model"]>,
	parentFile: string,
): SessionCloneParent {
	const session = ctx.session;
	const parentSessionId = session.sessionId;
	// Providers route on `promptCacheKey ?? sessionId`, so the parent's live
	// requests may cache under a pinned key that differs from its session id
	// (the parent being itself a fork/tan). Mirror exactly what the parent
	// populated the cache under — same rule as advisor and handoff calls.
	const parentPromptCacheKey = session.agent.promptCacheKey ?? parentSessionId;
	const thinkingLevel = session.configuredThinkingLevel();
	const systemPrompt = [...session.systemPrompt];
	const toolNames = session.getEnabledToolNames();
	const modelRegistry = session.modelRegistry;
	// Snapshot the parent's rebindable extensions and root policy at dispatch.
	// The child rebinds these (skipping discovery) so it re-registers the
	// parent's runtime providers on the shared model registry before the SDK's
	// syncExtensionSources prune runs — without this the child builds an empty
	// extension set and unregisters the parent's provider auth (no-key error).
	const parentPreparedExtensions = session.preparedExtensions;
	// Path-list fallback for the (rare) parent build path that produced no
	// prepared factories; the child rebinds from paths so it still re-registers
	// providers rather than pruning the shared registry from an empty set.
	const parentExtensionPaths = session.extensionPaths;
	const parentExtensionRoots = session.effectiveExtensionRoots;
	const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
	const mcpManager = ctx.mcpManager;
	const cwd = ctx.sessionManager.getCwd();
	const parentArtifactsDir = ctx.sessionManager.getArtifactsDir();
	// Use the session-manager id (not `session.sessionId`, which can diverge
	// after `/fresh` or a provider session override) so the clone resolves the
	// same local root the parent's large-paste writes and `local://` reads use —
	// notably the Windows short-root fallback keys `%TEMP%/omp-local/<id>` off it.
	const parentLocalSessionId = ctx.sessionManager.getSessionId();
	const localProtocolOptions = {
		getArtifactsDir: () => parentArtifactsDir,
		getSessionId: () => parentLocalSessionId,
	};
	const cloneDir = parentFile.slice(0, -6);
	const settings = createSubagentSettings(ctx.settings);
	const customTools = mcpManager ? createMCPProxyTools(mcpManager) : undefined;
	const enableLsp = ctx.settings.get("task.enableLsp") !== false;
	const agentRegistry = AgentRegistry.global();

	return {
		model,
		parentSessionId,
		ownerId,
		cloneDir,
		cloneFile: agentId => path.join(cloneDir, `${agentId}.jsonl`),
		forkTranscript: cloneFile =>
			SessionManager.forkFrom(parentFile, cwd, cloneDir, undefined, {
				copyArtifacts: false,
				suppressBreadcrumb: true,
				sessionFile: cloneFile,
				// A clone is a fresh agent forking the parent's transcript only for
				// context; its cost must reflect its own work, not the parent's
				// accumulated spend that session cost is otherwise derived from.
				resetInheritedCost: true,
				// The parent may be mid-turn: pair any tool call it left unresolved
				// with a synthetic aborted result so the clone inherits a terminal
				// transcript instead of rendering the parent's in-flight call as its
				// own pending work (issue #11118).
				repairInterruptedTail: true,
			}),
		sessionOptions: identity => {
			const tools = [...(customTools ?? []), ...(identity.extraTools ?? [])];
			return {
				cwd,
				sessionManager: identity.sessionManager,
				model,
				thinkingLevel,
				systemPrompt,
				toolNames,
				providerSessionId: identity.providerSessionId,
				providerPromptCacheKey: parentPromptCacheKey,
				modelRegistry,
				authStorage: modelRegistry.authStorage,
				settings,
				hasUI: false,
				enableMCP: false,
				customTools: tools.length > 0 ? tools : undefined,
				enableLsp,
				agentId: identity.agentId,
				agentDisplayName: identity.displayName,
				parentTaskPrefix: identity.agentId,
				parentAgentId: ownerId,
				agentRegistry,
				disableExtensionDiscovery: true,
				// `[]` is truthy and would make the child pick bindPreparedExtensions([])
				// over a populated path fallback, so collapse an empty list to undefined.
				preloadedPreparedExtensions: parentPreparedExtensions?.length ? parentPreparedExtensions : undefined,
				preloadedExtensionPaths: parentExtensionPaths?.length ? [...parentExtensionPaths] : undefined,
				extensionRoots: () => parentExtensionRoots,
				localProtocolOptions,
				...(identity.expectedAgentRef !== undefined ? { expectedAgentRef: identity.expectedAgentRef } : {}),
			};
		},
	};
}

/** Remove a clone transcript and its nested artifact directory. */
export async function removeCloneSession(cloneFile: string): Promise<void> {
	await Promise.allSettled([
		fs.rm(cloneFile, { force: true }),
		fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
	]);
}
