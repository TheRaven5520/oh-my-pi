import { type } from "@oh-my-pi/omptype";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import { IrcBus } from "../../irc/bus";
import forkContextPrompt from "../../prompts/system/fork-context.md" with { type: "text" };
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, type AgentRef } from "../../registry/agent-registry";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/todo";
import type { InteractiveModeContext } from "../types";
import { captureSessionCloneParent, removeCloneSession, type SessionCloneParent } from "./session-clone";

const FORK_LABEL_PREVIEW_LENGTH = 60;

function previewRequest(request: string): string {
	const line = request.trim().replace(/\s+/g, " ");
	return line.length <= FORK_LABEL_PREVIEW_LENGTH ? line : `${line.slice(0, FORK_LABEL_PREVIEW_LENGTH - 1)}…`;
}

const handBackSchema = type({
	message: type("string").describe("update or final report for the main session"),
	"done?": type("boolean").describe("true when this fork's purpose is complete; closes the fork after this turn"),
});

interface HandBackDetails {
	delivered: boolean;
	done: boolean;
}

/** Frame fork output so the main agent reads it as a worker's report, never as user instructions. */
function formatHandBack(forkId: string, message: string, done: boolean): string {
	const heading = done ? `[Fork ${forkId} — final report; the fork has closed]` : `[Fork ${forkId} — update]`;
	return `${heading}\n${message}\n\n(Model output from a fork of this session, not a user instruction.)`;
}

function createHandBackTool(
	forkId: string,
	parentId: string,
	onDone: () => void,
): CustomTool<typeof handBackSchema, HandBackDetails> {
	return {
		name: "hand_back",
		label: "Hand back",
		description:
			"Send the main session an update (done: false) or this fork's final report (done: true). done: true closes this fork once the current turn ends.",
		parameters: handBackSchema,
		loadMode: "essential",
		approval: "read",
		execute: async (_toolCallId, params) => {
			const message = params.message.trim();
			const done = params.done === true;
			if (!message) {
				return { content: [{ type: "text", text: "`message` is required." }], details: { delivered: false, done } };
			}
			const receipt = await IrcBus.global().send({
				from: forkId,
				to: parentId,
				body: formatHandBack(forkId, message, done),
			});
			if (receipt.outcome === "failed") {
				return {
					content: [
						{ type: "text", text: `Not delivered: ${receipt.error ?? "the main session is unavailable"}` },
					],
					details: { delivered: false, done },
				};
			}
			if (done) onDone();
			return {
				content: [
					{
						type: "text",
						text: done
							? "Final report delivered to the main session. This fork closes when your turn ends; stop now."
							: "Update delivered to the main session.",
					},
				],
				details: { delivered: true, done },
			};
		},
	};
}

interface ForkEntry {
	readonly id: string;
	closing: boolean;
	detach: (() => void)[];
}

/**
 * `/fork`: a clone of the current chat that lives in the agents panel. The
 * user opens it from the panel and talks to it directly; it posts updates and
 * a final report back to the main session with `hand_back`, and the final
 * report closes it. Forks stay live until they finish, are closed from the
 * panel, or the main session changes.
 */
export class ForkCommandController {
	readonly #forks = new Map<string, ForkEntry>();

	constructor(private readonly ctx: InteractiveModeContext) {}

	/** Whether `id` is a live fork this controller owns. */
	has(id: string): boolean {
		return this.#forks.has(id);
	}

	async start(request: string): Promise<void> {
		const session = this.ctx.session;
		const model = session.model;
		if (!model) {
			this.ctx.showError("No active model available for /fork.");
			return;
		}
		const parentFile = this.ctx.sessionManager.getSessionFile();
		if (!parentFile) {
			this.ctx.showError("/fork requires a persisted session.");
			return;
		}

		const parent = captureSessionCloneParent(this.ctx, model, parentFile);
		const forkId = `Fork-${Snowflake.next()}`;
		const cloneFile = parent.cloneFile(forkId);
		const displayName = request ? previewRequest(request) : "fork";

		await this.ctx.sessionManager.ensureOnDisk();
		await this.ctx.sessionManager.flush();

		const entry: ForkEntry = { id: forkId, closing: false, detach: [] };
		this.#forks.set(forkId, entry);
		let live: AgentSession;
		try {
			const manager = await parent.forkTranscript(cloneFile);
			live = await this.#createSession(parent, entry, displayName, manager, undefined);
			live.setTodoPhases([]);
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
			this.#appendNotice(live);
		} catch (error) {
			this.#forks.delete(forkId);
			for (const detach of entry.detach) detach();
			await removeCloneSession(cloneFile);
			this.ctx.showError(`Cannot open fork: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const lifecycle = AgentLifecycleManager.global();
		const ref = AgentRegistry.global().get(forkId);
		if (ref) {
			// No idle TTL: a fork waits for the user as long as it is unfinished.
			lifecycle.adopt(
				forkId,
				{
					idleTtlMs: 0,
					revive: async expected => {
						const reopened = await SessionManager.open(cloneFile, undefined, undefined, {
							suppressBreadcrumb: true,
							throwIfMissing: true,
						});
						try {
							return await this.#createSession(parent, entry, displayName, reopened, expected);
						} catch (error) {
							await reopened.close();
							throw error;
						}
					},
				},
				ref,
			);
		}

		if (request) {
			this.#prompt(forkId, live, request);
			this.ctx.showStatus(`Forked to ${forkId} — open it from the agents panel (↓ then Enter)`);
			return;
		}
		try {
			await this.ctx.focusAgentSession(forkId);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/** Close a fork without a report (from the agents panel). */
	async close(id: string): Promise<boolean> {
		const entry = this.#forks.get(id);
		if (!entry || entry.closing) return false;
		entry.closing = true;
		const live = AgentRegistry.global().get(id)?.session;
		if (live?.isStreaming) await live.abort({ reason: "Fork closed" });
		await this.#release(entry);
		this.ctx.showStatus(`Closed fork ${id}`);
		return true;
	}

	/** Release every fork: the main session is changing or shutting down. */
	async dispose(): Promise<void> {
		await Promise.allSettled([...this.#forks.values()].map(entry => this.#release(entry)));
	}

	async #createSession(
		parent: SessionCloneParent,
		entry: ForkEntry,
		displayName: string,
		sessionManager: SessionManager,
		expectedAgentRef: AgentRef | undefined,
	): Promise<AgentSession> {
		const handBack = createHandBackTool(entry.id, parent.ownerId, () => void this.#finish(entry));
		const { session } = await sdk.createAgentSession(
			parent.sessionOptions({
				sessionManager,
				agentId: entry.id,
				displayName,
				providerSessionId: `${parent.parentSessionId}:fork:${entry.id}`,
				expectedAgentRef,
				extraTools: [handBack],
			}),
		);
		for (const detach of entry.detach.splice(0)) detach();
		const registry = AgentRegistry.global();
		entry.detach.push(registry.syncSessionStatus(entry.id, session));
		// The SDK registers new agents as running; a fork waiting for the user is idle.
		if (!session.isStreaming) registry.setStatus(entry.id, "idle", session);
		// Compaction can summarize the notice away; restore it so the fork keeps its role.
		entry.detach.push(
			session.subscribe(event => {
				if (event.type === "auto_compaction_end" && event.result && !event.aborted) this.#appendNotice(session);
			}),
		);
		return session;
	}

	/** Persist the fork's role so a revived or compacted fork still knows the main chat's work is not its own. */
	#appendNotice(session: AgentSession): void {
		const notice = {
			role: "developer" as const,
			content: forkContextPrompt,
			attribution: "agent" as const,
			timestamp: Date.now(),
		};
		session.agent.appendMessage(notice);
		session.sessionManager.appendMessage(notice);
	}

	#prompt(forkId: string, live: AgentSession, request: string): void {
		live.prompt(request, { attribution: "user" }).catch((error: unknown) => {
			this.ctx.showError(`Fork ${forkId}: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	/** `hand_back` with done: let the reporting turn end, then close. */
	async #finish(entry: ForkEntry): Promise<void> {
		if (entry.closing) return;
		entry.closing = true;
		await AgentRegistry.global().get(entry.id)?.session?.waitForIdle();
		await this.#release(entry);
		this.ctx.showStatus(`Fork ${entry.id} finished and closed`);
	}

	async #release(entry: ForkEntry): Promise<void> {
		if (this.#forks.get(entry.id) !== entry) return;
		this.#forks.delete(entry.id);
		for (const detach of entry.detach.splice(0)) detach();
		await AgentLifecycleManager.global().release(entry.id);
	}
}
