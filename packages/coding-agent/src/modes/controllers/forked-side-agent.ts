import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, getAgentTombstonePath, MAIN_AGENT_ID, type AgentRef } from "../../registry/agent-registry";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import type { BtwHistoryTurn } from "../../session/btw-history";
import { SessionManager } from "../../session/session-manager";
import { initializeExtensions } from "../runtime-init";
import { createMCPProxyTools, createSubagentSettings } from "../../task/executor";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/todo";
import type { InteractiveModeContext } from "../types";

export interface ForkedSideAgent {
	readonly id: string;
	readonly sessionFile: string;
	run(options: {
		question: string;
		signal?: AbortSignal;
		onTextDelta?: (delta: string) => void;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage }>;
	park(): Promise<void>;
	close(): Promise<void>;
}

function assistantText(message: AssistantMessage | undefined): string {
	return (
		message?.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("")
			.trim() ?? ""
	);
}

async function removeCloneSession(cloneFile: string): Promise<void> {
	await Promise.allSettled([
		fs.rm(cloneFile, { force: true }),
		fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
	]);
}

function historyAssistant(turn: BtwHistoryTurn, model: NonNullable<AgentSession["model"]>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: turn.answer }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: turn.updatedAt,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** Create a persistent tool-enabled child transcript without dispatching a parent task. */
export async function createForkedSideAgent(
	ctx: InteractiveModeContext,
	existingAgentId?: string,
	history?: readonly BtwHistoryTurn[],
): Promise<ForkedSideAgent> {
	const parentFile = ctx.sessionManager.getSessionFile();
	const parent = ctx.session;
	const model = parent.model;
	if (!model) throw new Error("No active model available for /btw.");
	const parentSessionId = parent.sessionId;
	const parentPromptCacheKey = parent.agent.promptCacheKey ?? parentSessionId;
	const thinkingLevel = parent.configuredThinkingLevel();
	const systemPrompt = [...parent.systemPrompt];
	const parentPreparedExtensions = parent.preparedExtensions;
	const parentExtensionPaths = parent.extensionPaths;
	const parentExtensionRoots = parent.effectiveExtensionRoots;
	const parentArtifactsDir = ctx.sessionManager.getArtifactsDir();
	const persistent = parentFile !== undefined && parentArtifactsDir !== null;
	if (existingAgentId !== undefined && !persistent)
		throw new Error("Cannot revive a BTW side agent without session persistence.");
	const parentLocalSessionId = ctx.sessionManager.getSessionId();
	const cwd = ctx.sessionManager.getCwd();
	const modelRegistry = parent.modelRegistry;
	const ownerId = parent.getAgentId() ?? MAIN_AGENT_ID;
	const agentRegistry = AgentRegistry.global();
	const lifecycle = AgentLifecycleManager.global();
	const customTools = ctx.mcpManager ? createMCPProxyTools(ctx.mcpManager) : undefined;
	const settings = createSubagentSettings(ctx.settings);
	const enableLsp = ctx.settings.get("task.enableLsp") !== false;
	const toolNames = parent.getEnabledToolNames();
	const localProtocolOptions = {
		getArtifactsDir: () => parentArtifactsDir ?? null,
		getSessionId: () => parentLocalSessionId,
	};

	if (existingAgentId !== undefined && !/^Btw-[A-Za-z0-9_-]+$/.test(existingAgentId)) {
		throw new Error(`Invalid BTW side-agent id: ${existingAgentId}`);
	}
	const cloneId = existingAgentId ?? `Btw-${Snowflake.next()}`;
	let sessionFile = persistent ? path.join(parentArtifactsDir!, `${cloneId}.jsonl`) : "";
	const cloneFile = sessionFile;
	let session: AgentSession | undefined;
	let inMemorySession: AgentSession | undefined;
	let cloneManager: SessionManager | undefined;
	let existingRef: AgentRef | undefined;
	const fresh = existingAgentId === undefined;

	if (existingAgentId !== undefined) {
		existingRef = agentRegistry.get(existingAgentId);
		if (existingRef?.session) {
			session = existingRef.session;
		} else {
			let persistedFile = existingRef?.sessionFile ?? cloneFile;
			const currentTranscriptExists = await fs.access(cloneFile).then(
				() => true,
				() => false,
			);
			if (
				existingRef &&
				!existingRef.session &&
				existingRef.status === "parked" &&
				existingRef.sessionFile !== cloneFile &&
				currentTranscriptExists
			) {
				agentRegistry.unregister(existingAgentId, existingRef);
				existingRef = undefined;
				persistedFile = cloneFile;
			}
			if (
				existingRef?.sessionFile &&
				path.dirname(path.resolve(persistedFile)) !== path.resolve(parentArtifactsDir!)
			) {
				throw new Error("BTW side-agent transcript does not belong to its parent artifact directory.");
			}
			sessionFile = persistedFile;
			const tombstoneExists = await fs.access(getAgentTombstonePath(persistedFile)).then(
				() => true,
				() => false,
			);
			if (tombstoneExists) throw new Error(`BTW side agent ${existingAgentId} was terminated.`);
			try {
				await fs.access(persistedFile);
			} catch {
				throw new Error(`BTW side-agent transcript is missing: ${persistedFile}`);
			}
			if (!existingRef) {
				existingRef = agentRegistry.registerIfAvailable(
					{
						id: existingAgentId,
						displayName: "btw",
						kind: "sub",
						parentId: ownerId,
						session: null,
						sessionFile: persistedFile,
						status: "parked",
					},
					null,
				);
				if (!existingRef) throw new Error(`BTW side agent ${existingAgentId} is already registered.`);
			}
			if (existingRef.status !== "parked" || existingRef.session) {
				throw new Error(`BTW side agent ${existingAgentId} is not available for revival.`);
			}
		}
	}

	const buildOptions = (sessionManager: SessionManager, expectedAgentRef: AgentRef | undefined) => ({
		cwd,
		sessionManager,
		model,
		thinkingLevel,
		systemPrompt,
		toolNames,
		providerSessionId: `${parentSessionId}:btw:${cloneId}`,
		providerPromptCacheKey: parentPromptCacheKey,
		modelRegistry,
		authStorage: modelRegistry.authStorage,
		settings,
		hasUI: false,
		enableMCP: false,
		customTools,
		enableLsp,
		agentId: cloneId,
		agentDisplayName: "btw",
		parentTaskPrefix: cloneId,
		parentAgentId: ownerId,
		agentRegistry,
		expectedAgentRef,
		disableExtensionDiscovery: true,
		preloadedPreparedExtensions: parentPreparedExtensions?.length ? parentPreparedExtensions : undefined,
		preloadedExtensionPaths: parentExtensionPaths?.length ? [...parentExtensionPaths] : undefined,
		extensionRoots: () => parentExtensionRoots,
		localProtocolOptions,
	});

	if (!session && fresh) {
		try {
			if (persistent) {
				await ctx.sessionManager.ensureOnDisk();
				await ctx.sessionManager.flush();
				cloneManager = await SessionManager.forkFrom(parentFile!, cwd, parentArtifactsDir!, undefined, {
					copyArtifacts: false,
					suppressBreadcrumb: true,
					sessionFile: cloneFile,
					resetInheritedCost: true,
					repairInterruptedTail: true,
				});
			} else {
				cloneManager = SessionManager.forkInMemory(ctx.sessionManager, {
					resetInheritedCost: true,
					repairInterruptedTail: true,
				});
			}
			const created = await sdk.createAgentSession(buildOptions(cloneManager, undefined));
			session = created.session;
			if (!persistent) inMemorySession = session;
			await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });
			if (history) {
				for (const turn of history) {
					const userMessage = {
						role: "user" as const,
						content: [{ type: "text" as const, text: turn.question }],
						attribution: "user" as const,
						timestamp: turn.createdAt,
					};
					const assistantMessage = historyAssistant(turn, model);
					session.agent.appendMessage(userMessage);
					cloneManager.appendMessage(userMessage);
					session.agent.appendMessage(assistantMessage);
					cloneManager.appendMessage(assistantMessage);
				}
			}
			session.setTodoPhases([]);
			cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
		} catch (error) {
			await session?.dispose().catch(() => {});
			await cloneManager?.close().catch(() => {});
			if (persistent) await removeCloneSession(cloneFile);
			throw error;
		}
	}

	if (persistent) {
		const revive = async (expectedAgentRef: AgentRef): Promise<AgentSession> => {
			const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			let createdSession: AgentSession | undefined;
			try {
				const created = await sdk.createAgentSession(buildOptions(reopened, expectedAgentRef));
				createdSession = created.session;
				await initializeExtensions(created.session, { reportSendError: () => {}, reportRuntimeError: () => {} });
				agentRegistry.syncSessionStatus(cloneId, created.session);
				return created.session;
			} catch (error) {
				await createdSession?.dispose().catch(() => {});
				await reopened.close().catch(() => {});
				throw error;
			}
		};

		let ref = agentRegistry.get(cloneId);
		if (!ref && existingRef) ref = existingRef;
		if (!ref) throw new Error(`Failed to register BTW side agent ${cloneId}.`);
		lifecycle.adopt(cloneId, { idleTtlMs: 0, revive }, ref);
		if (session) {
			await lifecycle.park(cloneId);
			session = undefined;
		}
	}

	const pendingRuns = new Set<Promise<unknown>>();
	let closed = false;
	const helper: ForkedSideAgent = {
		id: cloneId,
		sessionFile,
		run: ({ question, signal, onTextDelta }) => {
			const task = (async () => {
				if (closed) throw new Error("BTW side agent is closed.");
				if (signal?.aborted) throw new Error("Aborted before execution");
				const live = persistent ? await lifecycle.ensureLive(cloneId) : inMemorySession;
				if (!live) throw new Error("BTW side agent is closed.");
				if (signal?.aborted) {
					await live.abort({ reason: "BTW request cancelled" });
					throw new Error("Aborted before execution");
				}
				let replyText = "";
				const beforeCount = live.agent.state.messages.length;
				const unsubscribe = live.subscribe(event => {
					if (event.type !== "message_update" || event.message.role !== "assistant") return;
					if (event.assistantMessageEvent.type === "text_delta") {
						replyText += event.assistantMessageEvent.delta;
						onTextDelta?.(event.assistantMessageEvent.delta);
					}
				});
				const onAbort = () => void live.abort({ reason: "BTW request cancelled" });
				if (signal) signal.addEventListener("abort", onAbort, { once: true });
				try {
					await live.prompt(question, { attribution: "user" });
					await live.waitForIdle();
					while (live.hasPendingAsyncWork()) {
						if (signal?.aborted) throw new Error("Aborted while settling descendant work");
						const settling = live.settleAsyncWork();
						if (signal) await untilAborted(signal, settling);
						else await settling;
					}
					const message = live.getLastAssistantMessage();
					const produced = message !== undefined && live.agent.state.messages.slice(beforeCount).includes(message);
					if (!produced) throw new Error("BTW side agent produced no assistant response.");
					if (message.stopReason === "error" || message.stopReason === "aborted") {
						throw new Error("BTW side agent did not complete its response.");
					}
					return { replyText: assistantText(message) || replyText.trim(), assistantMessage: message };
				} finally {
					if (signal) signal.removeEventListener("abort", onAbort);
					unsubscribe();
				}
			})();
			pendingRuns.add(task);
			void task.then(
				() => pendingRuns.delete(task),
				() => pendingRuns.delete(task),
			);
			return task;
		},
		park: async () => {
			await Promise.allSettled(pendingRuns);
			if (persistent) await lifecycle.park(cloneId);
		},
		close: async () => {
			if (closed) return;
			closed = true;
			await Promise.allSettled(pendingRuns);
			if (persistent) {
				await lifecycle.park(cloneId);
			} else {
				await inMemorySession?.dispose().catch(() => {});
				inMemorySession = undefined;
			}
		},
	};
	return helper;
}
