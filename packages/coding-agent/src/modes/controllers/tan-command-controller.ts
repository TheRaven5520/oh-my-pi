import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import backgroundTanDispatchPrompt from "../../prompts/system/background-tan-dispatch.md" with { type: "text" };
import tanContextSwitchPrompt from "../../prompts/system/tan-context-switch.md" with { type: "text" };
import { AgentRegistry } from "../../registry/agent-registry";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../../session/messages";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/todo";
import type { InteractiveModeContext } from "../types";
import { captureSessionCloneParent, removeCloneSession } from "./session-clone";

const TAN_LABEL_PREVIEW_LENGTH = 80;

function previewWork(work: string): string {
	const singleLine = work.trim().replace(/\s+/g, " ");
	if (singleLine.length <= TAN_LABEL_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, TAN_LABEL_PREVIEW_LENGTH - 1)}…`;
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

export class TanCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	async start(work: string): Promise<void> {
		const trimmedWork = work.trim();
		if (!trimmedWork) {
			this.ctx.showStatus("Usage: /tan <work>");
			return;
		}

		const session = this.ctx.session;

		const model = session.model;
		if (!model) {
			this.ctx.showError("No active model available for /tan.");
			return;
		}

		const manager = session.asyncJobManager;
		if (!manager) {
			this.ctx.showError("Background jobs are disabled; enable async jobs to use /tan.");
			return;
		}

		const parentFile = this.ctx.sessionManager.getSessionFile();
		if (!parentFile) {
			this.ctx.showError("/tan requires a persisted session.");
			return;
		}

		const parent = captureSessionCloneParent(this.ctx, model, parentFile);
		const systemPrompt = [...session.systemPrompt];
		const ownerId = parent.ownerId;
		const agentRegistry = AgentRegistry.global();
		const cloneId = `Tan-${Snowflake.next()}`;
		const cloneFile = parent.cloneFile(cloneId);
		const label = `/tan ${previewWork(trimmedWork)}`;

		await this.ctx.sessionManager.ensureOnDisk();
		await this.ctx.sessionManager.flush();

		let jobId = "";
		try {
			const cloneManager = await parent.forkTranscript(cloneFile);

			jobId = manager.register(
				"task",
				label,
				async ({ signal }) => {
					if (signal.aborted) throw new Error("Aborted before execution");

					let clone: AgentSession | undefined;
					try {
						const created = await sdk.createAgentSession(
							parent.sessionOptions({
								sessionManager: cloneManager,
								agentId: cloneId,
								displayName: "tan",
								providerSessionId: `${parent.parentSessionId}:tan:${Snowflake.next()}`,
							}),
						);
						clone = created.session;
						clone.sessionManager?.appendSessionInit?.({
							systemPrompt: clone.systemPrompt ? clone.systemPrompt.join("\n\n") : systemPrompt.join("\n\n"),
							task: trimmedWork,
							tools: clone.getEnabledToolNames(),
						});
						const abortClone = () => {
							void clone?.abort();
						};
						signal.addEventListener("abort", abortClone, { once: true });
						// The fork inherits the parent's todo list via session entries;
						// its reminders would drag the tan back onto the parent's task.
						// Clear runtime state and persist an empty edit so reloads agree.
						clone.setTodoPhases([]);
						cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
						const injectContextSwitch = () => {
							clone?.agent.appendMessage({
								role: "developer",
								content: tanContextSwitchPrompt,
								attribution: "agent",
								timestamp: Date.now(),
							});
						};
						// The fork's request enters the transcript only once the initial
						// prompt dispatches (its first `agent_start`). Compaction that
						// fires before then is the pre-prompt pass on the inherited
						// context: the pending request has not been appended yet and the
						// dispatch adds it immediately after, so restoring it here would
						// send the assignment twice — re-inject only the notice above it.
						// Once the request is in history, restore the notice and request
						// together only when summarization actually dropped the request:
						// the notice must never claim a request that no longer follows it,
						// and a request the summarizer kept (a recent turn within
						// `compaction.keepRecentTokens`, or a prior re-injection still
						// live) must not be duplicated onto the tail, which would present
						// the same assignment again and risk restarting completed work.
						let requestDispatched = false;
						const unsubscribeCompaction = clone.subscribe(event => {
							if (event.type === "agent_start") {
								requestDispatched = true;
								return;
							}
							if (event.type !== "auto_compaction_end" || !event.result || event.aborted) return;
							if (!requestDispatched) {
								injectContextSwitch();
								return;
							}
							const requestRetained = (clone?.agent.state.messages ?? []).some(message => {
								if (message.role !== "user") return false;
								const content = message.content;
								return typeof content === "string"
									? content === trimmedWork
									: content.some(part => part.type === "text" && part.text === trimmedWork);
							});
							if (requestRetained) return;
							injectContextSwitch();
							clone?.agent.appendMessage({
								role: "user",
								content: [{ type: "text", text: trimmedWork }],
								attribution: "user",
								timestamp: Date.now(),
							});
						});
						try {
							if (signal.aborted) {
								abortClone();
								throw new Error("Aborted before execution");
							}
							// Inject a context-switch developer message so the clone knows
							// it is a tangential fork — its parent owns the prior conversation;
							// this agent must focus exclusively on the user's request.
							injectContextSwitch();
							await clone.prompt(trimmedWork, { attribution: "user" });
							await clone.waitForIdle();
							while (clone.hasPendingAsyncWork()) {
								if (signal.aborted) throw new Error("Aborted while settling descendant work");
								await untilAborted(signal, clone.settleAsyncWork());
							}
							return extractAssistantText(clone.getLastAssistantMessage()) || "(no output)";
						} finally {
							unsubscribeCompaction();
							signal.removeEventListener("abort", abortClone);
						}
					} finally {
						// Keep the finished tan in the Agent Hub instead of unregistering it:
						// flip the ref to parked BEFORE dispose so the sdk dispose wrapper
						// skips its unregister, then null the disposed session so the hub
						// treats it as a transcript-only parked agent. An aborted tan is
						// terminal — let dispose unregister it.
						if (clone) {
							if (signal.aborted) {
								agentRegistry.setStatus(cloneId, "aborted");
								await clone.dispose();
							} else {
								agentRegistry.setStatus(cloneId, "parked");
								await clone.dispose();
								agentRegistry.detachSession(cloneId);
							}
						}
					}
				},
				{ ownerId, agentId: cloneId },
			);
		} catch (error) {
			if (cloneFile) await removeCloneSession(cloneFile);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		const content = prompt.render(backgroundTanDispatchPrompt, { jobId, work: trimmedWork });
		// /tan is meant to run alongside an active session. While the parent turn is
		// still streaming, queue the dispatch breadcrumb for the next turn rather than
		// steering the in-flight response; when idle this same call appends + persists
		// the entry immediately (identical to omitting deliverAs).
		const wasStreaming = session.isStreaming;
		await session.sendCustomMessage(
			{
				customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
				content,
				display: true,
				attribution: "user",
				details: { jobId, work: trimmedWork, sessionFile: cloneFile },
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		if (!wasStreaming) this.ctx.rebuildChatFromMessages();
		this.ctx.showStatus(`Dispatched background tan ${jobId}`);
	}
}
