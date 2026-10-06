/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists every running subagent — detached background spawns and
 * sync task calls alike — as numbered `N Id: description` jump-list rows and
 * yields no output once nothing qualifies, so the block self-clears.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetHangulCompatibilityJamoWidthForTests, setHangulCompatibilityJamoWidth } from "@oh-my-pi/pi-tui";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import {
	InteractiveMode,
	layoutPinnedHud,
	renderSubagentDockLines,
	nextSubagentPreviewTickMs,
	renderSubagentHudLines,
	SubagentHudComponent,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { type ObservableSession, SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgDisplaySubagentLivePreview } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgTaskShowResolvedModelBadge } from "@oh-my-pi/pi-coding-agent/task/settings";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

function render(sessions: ObservableSession[], columns = 120, livePreview = false): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns, false, livePreview).join("\n"));
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	describe("model badges", () => {
		beforeEach(async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { "task.showResolvedModelBadge": true } });
		});

		afterEach(() => {
			resetSettingsForTest();
		});

		it("places the model, its level and optional advisor before the detached agent name", () => {
			const session = makeSession({
				id: "BadgeWorker",
				agent: "scout",
				description: "Inspect rendering",
				progress: makeProgress({
					id: "BadgeWorker",
					resolvedModel: "openai/gpt-5:high",
					resolvedModelIdentity: "openai/gpt-5",
					resolvedThinkingLevel: ThinkingLevel.High,
					advisor: true,
				}),
			});
			const out = render([session]);
			expect(out).toContain(`GPT-5 (high) ${theme.icon.advisor} BadgeWorker`);
			expect(out).not.toContain("openai/");
			expect(out).toContain(`BadgeWorker ${theme.format.bracketLeft}scout${theme.format.bracketRight}`);
			expect(out).toContain(": Inspect rendering");

			session.progress = makeProgress({
				id: "BadgeWorker",
				resolvedModel: "openai/gpt-5:high",
				resolvedModelIdentity: "openai/gpt-5",
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: false,
			});
			const withoutAdvisor = render([session]);
			expect(withoutAdvisor).toContain("GPT-5 (high) BadgeWorker");
			expect(withoutAdvisor).not.toContain(theme.icon.advisor);
		});

		it("keeps metadata hidden when disabled or settings have not initialized", () => {
			const sessions = [
				makeSession({
					id: "HiddenBadge",
					description: "Inspect rendering",
					progress: makeProgress({
						id: "HiddenBadge",
						resolvedModel: "openai/gpt-5:high",
						resolvedModelIdentity: "openai/gpt-5",
						resolvedThinkingLevel: ThinkingLevel.High,
						advisor: true,
					}),
				}),
			];
			cfgTaskShowResolvedModelBadge.override(Settings.instance, false);
			const disabled = render(sessions);
			expect(disabled).toContain(`${theme.status.done} HiddenBadge: Inspect rendering`);
			expect(disabled).not.toContain("GPT-5");
			expect(disabled).not.toContain(theme.icon.advisor);

			resetSettingsForTest();
			expect(render(sessions)).toBe(disabled);
		});

		it("preserves model identity and the agent name while fitting descriptions and task previews", () => {
			const metadata = {
				resolvedModel: `provider/${"shared-prefix-".repeat(8)}variant-z:high`,
				resolvedModelIdentity: `provider/${"shared-prefix-".repeat(8)}variant-z`,
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: true,
			};
			const sessions = [
				makeSession({
					id: "Description",
					description: "Inspect rendering ".repeat(20),
					progress: makeProgress({ id: "Description", ...metadata }),
				}),
				makeSession({
					id: "TaskPreview",
					progress: makeProgress({ id: "TaskPreview", task: "Inspect rendering ".repeat(20), ...metadata }),
				}),
			];
			const lines = render(sessions, 60).split("\n");
			for (const id of ["Description", "TaskPreview"]) {
				const row = lines.find(line => line.includes(id))!;
				expect(row).toContain(`variant-z (high) ${theme.icon.advisor} ${id}`);
				expect(row.indexOf("variant-z")).toBeLessThan(row.indexOf(id));
				expect(row).not.toContain(":high");
			}
			for (const line of lines) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
			}
		});

		it("reserves custom tree prefixes, outer indent and roles before optional details", () => {
			const priorTree = Object.getOwnPropertyDescriptor(theme, "tree");
			try {
				Object.defineProperty(theme, "tree", {
					configurable: true,
					value: { ...theme.tree, branch: "界├", last: "界界└", vertical: "界界│" },
				});
				const sessions = [
					makeSession({
						id: `LongWorker${"界".repeat(30)}`,
						agent: `custom-role-${"extended-".repeat(10)}`,
						description: "Every available column ".repeat(10),
						progress: makeProgress({ id: "LongWorker", resolvedModelIdentity: "provider/model", advisor: true }),
					}),
					makeSession({ id: "ShortWorker", agent: "scout", description: "Every available column ".repeat(10) }),
				];
				for (const enabled of [true, false]) {
					cfgTaskShowResolvedModelBadge.override(Settings.instance, enabled);
					for (const width of [40, 120, 40]) {
						const rows = render(sessions, width).split("\n");
						expect(rows.find(row => row.includes("LongWorker"))).toStartWith(" 界├ ");
						expect(rows.find(row => row.includes("ShortWorker"))).toStartWith(" 界界└ ");
						for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
						expect(rows.find(row => row.includes("LongWorker"))).toContain("LongWorker");
						expect(rows.find(row => row.includes("ShortWorker"))).toContain(
							`${theme.format.bracketLeft}scout${theme.format.bracketRight}`,
						);
					}
				}
			} finally {
				if (priorTree) Object.defineProperty(theme, "tree", priorTree);
				else Reflect.deleteProperty(theme, "tree");
			}
		});

		it("preserves a legacy selector without inventing a thinking level", () => {
			const out = render([
				makeSession({
					id: "LegacyWorker",
					progress: makeProgress({ id: "LegacyWorker", resolvedModel: "custom/model:high" }),
				}),
			]);
			expect(out).toContain(`${theme.status.done} model:high LegacyWorker`);
			expect(out).not.toContain("(high)");
		});
	});

	it("renders running subagents as Id: description under a Subagents header", () => {
		const out = render([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(out).toContain("Subagents");
		expect(out).toContain("AuthLoader: Refactoring the auth flow");
		expect(out).toContain("SchemaMigrator: Migrating the users table");
	});

	it("shows a non-default role badge and hides descriptions that only echo the id", () => {
		const withRole = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "Refactor the auth flow",
			}),
		]);
		expect(withRole).toContain("AuthLoader");
		expect(withRole).toMatch(/AuthLoader.*scout/);
		expect(withRole).toContain("Refactor the auth flow");

		const echoed = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(echoed).toContain("AuthLoader");
		expect(echoed).toMatch(/AuthLoader.*scout/);
		expect(echoed).not.toContain("AuthLoader: AuthLoader");

		const collision = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(collision).toContain("AuthLoader-3");
		expect(collision).toMatch(/AuthLoader-3.*scout/);
		expect(collision).not.toContain("AuthLoader-3: AuthLoader");

		const mixedCase = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "authloader",
			}),
		]);
		expect(mixedCase).toContain("AuthLoader-3");
		expect(mixedCase).not.toContain("AuthLoader-3: authloader");

		const defaultWorker = render([
			makeSession({ id: "SchemaMigrator", agent: "task", description: "Migrate users" }),
		]);
		expect(defaultWorker).toContain("SchemaMigrator: Migrate users");
		expect(defaultWorker).not.toMatch(/SchemaMigrator.*task/);
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expect(out).toContain("StillRunning: live work");
		expect(out).not.toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("falls back to the description and task carried by progress snapshots", () => {
		const fromProgressDesc = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", description: "From progress" }) }),
		]);
		expect(fromProgressDesc).toContain("Worker: From progress");

		const fromTask = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", task: "Investigate flaky CI on macOS" }) }),
		]);
		expect(fromTask).toContain("Worker Investigate flaky CI on macOS");

		const multiLineTask = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				progress: makeProgress({
					id: "ReviewShell",
					agent: "scout",
					task: "Complete assignment thoroughly:\n\n# Target\nFiles: src/foo.ts",
				}),
			}),
		]);
		expect(multiLineTask).toContain("ReviewShell");
		expect(multiLineTask).toContain("⟧ Files: src/foo.ts");
		expect(multiLineTask).not.toContain("#");

		const multiLineDesc = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				description: "First line\n\nSecond line",
			}),
		]);
		expect(multiLineDesc).toContain("ReviewShell");
		expect(multiLineDesc).toContain("First line ↵ Second line");
		expect(multiLineDesc).not.toContain("\nSecond line");
	});
	it("lists sync and detached spawns alike", () => {
		// Sync task spawn (parent blocked on the call) and eval `agent()` spawn
		// (no detached flag at all) join the pinned jump list.
		const sessions = [
			makeSession({ id: "SyncSpawn", description: "inline task work", detached: false }),
			makeSession({ id: "EvalSpawn", description: "eval cell work", detached: undefined }),
			makeSession({ id: "BackgroundSpawn", description: "detached work" }),
		];
		const out = render(sessions);
		expect(out).toContain("BackgroundSpawn: detached work");
		expect(out).toContain("SyncSpawn: inline task work");
		expect(out).toContain("EvalSpawn: eval cell work");
		const hud = new SubagentHudComponent(renderSubagentHudLines(sessions, 120), [
			"SyncSpawn",
			"EvalSpawn",
			"BackgroundSpawn",
		]);
		hud.render(120);
		expect(hud.getClickAgentAtRow(2)).toBe("SyncSpawn");
		expect(hud.getClickAgentAtRow(3)).toBe("EvalSpawn");
		expect(hud.getClickAgentAtRow(4)).toBe("BackgroundSpawn");
	});
	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = render(registry.getSessions());
		expect(out).toContain("Detached: background work");
		expect(out).toContain("FromProgress: background work");
		expect(out).toContain("Inline: sync work");
	});

	it("renders nested ids as a breadcrumb and truncates long descriptions to the viewport", () => {
		const out = render([makeSession({ id: "Anna.Bob", description: `start ${"x".repeat(300)} end` })], 60);
		expect(out).toContain("Anna>Bob:");
		expect(out).not.toContain("end");
		for (const line of out.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("dedupes frames dual-published on the session bus and the shared bus", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const kinds: string[] = [];
		registry.onChange(kind => kinds.push(kind));
		const payload = makeLifecycle("DualPublished", 0, "dual-published frame");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		expect(kinds).toEqual(["lifecycle"]);
		expect(registry.getActiveSubagentCount()).toBe(1);
		registry.dispose();
	});

	it("keeps subagent registry order stable while progress arrives out of order", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const activeIds = () =>
			registry
				.getSessions()
				.filter(session => session.kind === "subagent" && session.status === "active")
				.map(session => session.id);

		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("SelectorSurfaces", 0, "Map model-selector resolution surfaces"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);
	});

	it("renders every live agent when expanded, with a collapse row", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = Bun.stripANSI(renderSubagentHudLines(active, 120, true).join("\n"));

		for (const session of active) {
			expect(out).toContain(`${session.id}: ${session.description}`);
		}
		expect(out).not.toContain("more running");
		expect(out).toContain("show less");
	});

	it("collapses to a few rows with an expander by default", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = render(active, 120);
		expect(out).toContain("Worker0: job 0");
		expect(out).toContain("Worker2: job 2");
		expect(out).not.toContain("Worker3: job 3");
		expect(out).toContain("7 more — expand");
		expect(out).not.toContain("show less");
	});

	describe("live preview", () => {
		it("shows the current tool call only when enabled", () => {
			const sessions = [
				makeSession({
					id: "AuthLoader",
					description: "Refactoring the auth flow",
					progress: makeProgress({
						id: "AuthLoader",
						currentTool: "read",
						currentToolArgs: "src/auth.ts:50-100",
					}),
				}),
			];
			expect(render(sessions)).not.toContain("read: src/auth.ts:50-100");
			const out = render(sessions, 120, true);
			expect(out).toContain("AuthLoader: Refactoring the auth flow");
			expect(out).toContain("read: src/auth.ts:50-100");
		});

		it("falls back to the most recent tool when idle between calls", () => {
			const out = render(
				[
					makeSession({
						id: "Worker",
						progress: makeProgress({
							id: "Worker",
							recentTools: [{ tool: "grep", args: "renderSubagentHudLines", endMs: Date.now() }],
						}),
					}),
				],
				120,
				true,
			);
			expect(out).toContain("grep: renderSubagentHudLines");
		});

		it("adds an elapsed marker to long-running calls and stays within the viewport", () => {
			const columns = 120;
			const out = render(
				[
					makeSession({
						id: "Builder",
						progress: makeProgress({
							id: "Builder",
							currentTool: "bash",
							currentToolArgs: "npm test",
							currentToolStartMs: Date.now() - 10_000,
						}),
					}),
				],
				columns,
				true,
			);
			const toolRow = out.split("\n").find(line => line.includes("bash: npm test"));
			expect(toolRow).toMatch(/\d+s$/);
			for (const line of out.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
			}
		});

		it("shortens long tool details to the viewport", () => {
			const columns = 60;
			const out = render(
				[
					makeSession({
						id: "Reader",
						progress: makeProgress({
							id: "Reader",
							currentTool: "read",
							currentToolArgs: "x".repeat(300),
							currentToolStartMs: Date.now() - 10_000,
						}),
					}),
				],
				columns,
				true,
			);
			expect(out).toContain("read: xxxxxxxx");
			for (const line of out.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
			}
		});
		it("shortens home-directory paths in preview details", () => {
			const homeFile = `${os.homedir()}/.ssh/config`;
			const out = render(
				[
					makeSession({
						id: "Reader",
						progress: makeProgress({
							id: "Reader",
							currentTool: "read",
							currentToolArgs: `cat ${homeFile}`,
						}),
					}),
				],
				120,
				true,
			);
			expect(out).toContain("cat ~/.ssh/config");
			expect(out).not.toContain(os.homedir());
		});

		it("shortens a path argument by its key but keeps a literal search pattern as written", () => {
			const homeFile = `${os.homedir()}/.ssh/config`;
			const preview = (key: string) =>
				render(
					[
						makeSession({
							id: "Reader",
							progress: makeProgress({
								id: "Reader",
								currentTool: "grep",
								currentToolArgs: homeFile,
								currentToolArgsKey: key,
							}),
						}),
					],
					200,
					true,
				);
			expect(preview("path")).toContain("~/.ssh/config");
			expect(preview("path")).not.toContain(os.homedir());
			// A search pattern that names a home path must still show what was searched.
			expect(preview("pattern")).toContain(homeFile);
		});

		it("marks the last completed call with how it ended while idle between calls", () => {
			const rowFor = (isError: boolean) =>
				render(
					[
						makeSession({
							id: "Worker",
							progress: makeProgress({
								id: "Worker",
								recentTools: [{ tool: "read", args: "a.ts", argsKey: "path", isError, endMs: Date.now() }],
							}),
						}),
					],
					120,
					true,
				)
					.split("\n")
					.find(line => line.includes("read: a.ts"));
			const success = Bun.stripANSI(theme.styledSymbol("status.success", "success"));
			const error = Bun.stripANSI(theme.styledSymbol("status.error", "error"));
			expect(rowFor(false)).toContain(`${success} read: a.ts`);
			expect(rowFor(true)).toContain(`${error} read: a.ts`);
			expect(rowFor(false)).not.toContain(error);
		});

		it("keeps the elapsed marker with a very long tool name at a narrow width", () => {
			const columns = 40;
			const out = render(
				[
					makeSession({
						id: "Mcp",
						progress: makeProgress({
							id: "Mcp",
							currentTool: `mcp__tool_${"x".repeat(120)}`,
							currentToolArgs: "some detail that cannot fit",
							currentToolStartMs: Date.now() - 20_000,
						}),
					}),
				],
				columns,
				true,
			);
			const toolRow = out.split("\n").find(line => line.includes("mcp__tool_"));
			expect(toolRow).toBeDefined();
			expect(toolRow).toMatch(/\d+s$/);
			for (const line of out.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
			}
		});

		it("fits every rendered component row within the viewport without wrapping the elapsed marker", () => {
			const sessions = [
				makeSession({
					id: "Builder",
					description: "Narrow build",
					progress: makeProgress({
						id: "Builder",
						currentTool: "bash",
						currentToolArgs: `cat ${os.homedir()}/.ssh/config`,
						currentToolStartMs: Date.now() - 10_000,
					}),
				}),
				makeSession({
					id: "Reader",
					progress: makeProgress({
						id: "Reader",
						currentTool: "read",
						currentToolArgs: "x".repeat(300),
						currentToolStartMs: Date.now() - 12_000,
					}),
				}),
			];
			for (const columns of [60, 120]) {
				const hud = new SubagentHudComponent(
					renderSubagentHudLines(sessions, columns, false, true),
					sessions.map(session => session.id),
				);
				const rows = hud.render(columns).map(row => Bun.stripANSI(row));
				for (const row of rows) {
					expect(Bun.stringWidth(row)).toBeLessThanOrEqual(columns);
				}
				const elapsedRows = rows.filter(row => /\d+s/.test(row));
				expect(elapsedRows.length).toBeGreaterThan(0);
				for (const row of elapsedRows) {
					expect(row).toMatch(/bash|read/);
				}
			}
		});

		it("routes clicks on a preview row to its agent and keeps later rows and the expander aligned", () => {
			const sessions = ["Alpha", "Beta", "Gamma", "Delta"].map(id =>
				makeSession({ id, progress: makeProgress({ id, currentTool: "read", currentToolArgs: `${id}.ts` }) }),
			);
			const layout = layoutPinnedHud(sessions.length, false);
			const hud = new SubagentHudComponent(
				renderSubagentHudLines(sessions, 120, false, true),
				sessions.map(session => session.id),
				layout.toggleRow,
			);
			const rows = hud.render(120).map(row => Bun.stripANSI(row));
			const rowOf = (text: string) => rows.findIndex(row => row.includes(text));
			expect(hud.getClickAgentAtRow(rowOf("Alpha.ts"))).toBe("Alpha");
			expect(hud.getClickAgentAtRow(rowOf("Beta"))).toBe("Beta");
			expect(hud.getClickAgentAtRow(rowOf("Gamma.ts"))).toBe("Gamma");
			expect(hud.getClickAgentAtRow(rowOf("more — expand"))).toBe(PINNED_HUD_TOGGLE_ID);
		});

		it("labels a call with its own intent, never an earlier call's", () => {
			const out = render(
				[
					makeSession({
						id: "Worker",
						progress: makeProgress({
							id: "Worker",
							lastIntent: "Reading auth config",
							currentTool: "mcp__db_query",
							currentToolArgs: "SELECT 1",
							recentTools: [{ tool: "read", args: "auth.ts", intent: "Reading auth config", endMs: 1 }],
						}),
					}),
					makeSession({
						id: "Between",
						progress: makeProgress({
							id: "Between",
							lastIntent: "Reading auth config",
							recentTools: [{ tool: "mcp__db_query", args: "SELECT 2", endMs: 2 }],
						}),
					}),
					makeSession({
						id: "Intentful",
						progress: makeProgress({
							id: "Intentful",
							currentTool: "read",
							currentToolArgs: "auth.ts",
							currentToolIntent: "Checking the session cookie",
						}),
					}),
				],
				120,
				true,
			);
			expect(out).toContain("mcp__db_query: SELECT 1");
			expect(out).toContain("mcp__db_query: SELECT 2");
			expect(out).toContain("read: Checking the session cookie");
			expect(out).not.toContain("Reading auth config");
		});

		it("keeps the header and agent rows within the padded HUD width", () => {
			const sessions = [
				makeSession({ id: `Worker${"W".repeat(80)}`, description: "Every available column ".repeat(10) }),
			];
			for (const columns of [40, 60]) {
				const hud = new SubagentHudComponent(renderSubagentHudLines(sessions, columns, false, true), [
					sessions[0]!.id,
				]);
				// No wrapping: exactly the blank row, the header and one agent row.
				expect(hud.render(columns)).toHaveLength(3);
			}
		});

		it("arms the repaint for when the elapsed marker first shows, then every second", () => {
			const now = 100_000;
			const midCall = (id: string, startMs: number) =>
				makeSession({ id, progress: makeProgress({ id, currentTool: "bash", currentToolStartMs: startMs }) });
			const thinking = makeSession({ id: "Thinking", progress: makeProgress({ id: "Thinking" }) });
			expect(nextSubagentPreviewTickMs([thinking], now)).toBeUndefined();
			expect(nextSubagentPreviewTickMs([midCall("Fresh", now - 1_000)], now)).toBe(4_001);
			expect(nextSubagentPreviewTickMs([midCall("Long", now - 30_000)], now)).toBe(1_000);
			expect(
				nextSubagentPreviewTickMs([thinking, midCall("Fresh", now - 4_500), midCall("Long", now - 30_000)], now),
			).toBe(501);
		});
	});
});

describe("subagent dock lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const renderDock = (sessions: ObservableSession[], columns = 120, selectedId?: string): string =>
		Bun.stripANSI(renderSubagentDockLines(sessions, columns, selectedId).join("\n"));

	it("renders running agents with identity and no task descriptions", () => {
		const out = renderDock([
			makeSession({
				id: "AuthLoader",
				description: "Refactoring the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					resolvedModelIdentity: "sprilicred-anthropic/claude-opus-5-5",
					resolvedThinkingLevel: ThinkingLevel.High,
				}),
			}),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(out).toContain("agents · main");
		expect(out).toContain("AuthLoader · Opus 5.5 (high)");
		expect(out).toContain("SchemaMigrator");
		expect(out).not.toContain("Refactoring the auth flow");
		expect(out).not.toContain("Migrating the users table");
	});
	it("ends a running row with Claude Code-style stats whose time ticks from the run start", () => {
		const startedAtMs = 1_000_000;
		const session = makeSession({
			id: "Indexer",
			description: "Indexing the repo",
			progress: makeProgress({ id: "Indexer", toolCount: 12, tokens: 34_512, durationMs: 5_000, startedAtMs }),
		});
		const at = (elapsedMs: number) =>
			Bun.stripANSI(
				renderSubagentDockLines([session], 120, undefined, false, { now: startedAtMs + elapsedMs }).join("\n"),
			);
		expect(at(83_400)).toContain("Indexer · 12 tool uses · 34.5k tokens · 1m 23s");
		// Between progress snapshots the time keeps counting from the start, not the last snapshot.
		expect(at(84_600)).toContain("· 1m 24s");
	});

	it("shows a finished row's recorded duration, and nothing it does not know yet", () => {
		const out = renderDock([
			makeSession({ id: "Fresh", description: "just spawned", progress: makeProgress({ id: "Fresh" }) }),
			makeSession({
				id: "Waiting",
				status: "completed",
				description: "fork",
				progress: makeProgress({ id: "fork-1", toolCount: 1, tokens: 950, durationMs: 45_000, startedAtMs: 1 }),
			}),
		]);
		expect(out).toContain("Fresh");
		expect(out).not.toContain("just spawned");
		expect(out).not.toContain("0 tool uses");
	});

	it("does not add a task brief to compact agent rows", () => {
		const session = makeSession({
			id: "Briefed",
			progress: makeProgress({ id: "Briefed", task: "# Target\nsrc/foo.ts\n# Change\n1. Rename bar" }),
		});
		const lines = Bun.stripANSI(renderSubagentDockLines([session], 120).join("\n")).split("\n");
		const row = lines.find(line => line.includes("Briefed"));
		expect(row).toContain("Briefed");
		expect(row).not.toContain("src/foo.ts");
		expect(row).not.toContain("Rename bar");
	});

	it("keeps a compact row width without task descriptions", () => {
		const out = renderDock([makeSession({ id: "Multi", description: "first line\nsecond line\n\nthird" })], 60);
		expect(out).toContain("Multi");
		expect(out).not.toContain("first line");
		expect(out).not.toContain("second line");
		expect(out).not.toContain("third");
		for (const line of out.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
	});

	it("keeps the stats on a narrow terminal", () => {
		const session = makeSession({
			id: "Worker",
			description: "A very long description of the work this agent is doing right now",
			progress: makeProgress({ id: "Worker", toolCount: 3, tokens: 12_000, startedAtMs: 0 }),
		});
		const out = Bun.stripANSI(renderSubagentDockLines([session], 50, undefined, false, { now: 45_000 }).join("\n"));
		expect(out).toContain("Worker · 3 tool uses · 12k tokens · 45s");
		for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(50);
	});

	it("uses the caller's stats for rows without progress", () => {
		const out = Bun.stripANSI(
			renderSubagentDockLines([makeSession({ id: "Plain", description: "no progress" })], 120, undefined, false, {
				statsFor: () => ({ tools: 1, tokens: 2_000_000 }),
			}).join("\n"),
		);
		expect(out).toContain("Plain · 1 tool use · 2m tokens");
		expect(out).not.toContain("no progress");
	});

	it("shows only active subagents and hides the dock once none are working", () => {
		const out = renderDock([
			makeSession({ id: "Running", description: "live work" }),
			makeSession({ id: "Done", status: "completed", description: "finished work" }),
			makeSession({ id: "Aborted", status: "aborted", description: "cancelled work" }),
		]);
		expect(out).toContain("Running");
		expect(out).toContain("1 active");
		expect(out).not.toContain("live work");
		expect(out).not.toContain("Done");
		expect(out).not.toContain("Aborted");
		expect(renderDock([makeSession({ id: "Done", status: "completed" })])).toBe("");
	});

	it("keeps an unfinished fork listed while it waits for the user", () => {
		const out = renderDock([
			makeSession({ id: "Fork-0001", label: "look into the flaky test", status: "completed" }),
			makeSession({ id: "Done", status: "completed", description: "finished work" }),
		]);
		expect(out).toContain("⑂");
		expect(out).toContain("Fork-0001");
		expect(out).not.toContain("look into the flaky test");
		expect(out).toContain("0 active · 1 fork");
		expect(out).not.toContain("Done");
		expect(renderDock([makeSession({ id: "Fork-0001", status: "aborted" })])).toBe("");
	});

	it("scrolls the compact window to keep the selected agent visible", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({ id: `Worker${index}`, description: `job ${index}` }),
		);
		const out = renderDock(active, 120, "Worker8");
		expect(out).toContain("Worker5");
		expect(out).toContain("Worker8");
		expect(out).not.toContain("Worker4");
		expect(out).not.toContain("job 5");
		expect(out).toContain("… 5 above");
		expect(out).toContain("… 1 more — expand");
		expect(out).toContain("Enter open");
	});
});

describe("SubagentHudComponent click rows", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("maps item rows to session ids and chrome rows nowhere", () => {
		const lines = renderSubagentHudLines([makeSession({ id: "Alpha" }), makeSession({ id: "Beta" })], 120);
		const hud = new SubagentHudComponent(lines, ["Alpha", "Beta"]);

		const rendered = hud.render(120);
		expect(rendered).toHaveLength(lines.length);
		expect(Bun.stripANSI(rendered[2] ?? "")).toContain("Alpha");
		expect(Bun.stripANSI(rendered[3] ?? "")).toContain("Beta");

		expect(hud.getClickAgentAtRow(0)).toBeUndefined();
		expect(hud.getClickAgentAtRow(1)).toBeUndefined();
		expect(hud.getClickAgentAtRow(2)).toBe("Alpha");
		expect(hud.getClickAgentAtRow(3)).toBe("Beta");
		expect(hud.getClickAgentAtRow(4)).toBeUndefined();
		expect(hud.getClickAgentAtRow(-1)).toBeUndefined();
	});

	it("resolves the expander row to the toggle sentinel", () => {
		const hud = new SubagentHudComponent(["", "Subagents", "row", "toggle"], ["Only"], 3);
		hud.render(120);
		expect(hud.getClickAgentAtRow(3)).toBe(PINNED_HUD_TOGGLE_ID);
		expect(hud.getClickAgentAtRow(2)).toBe("Only");
	});

	it("maps wrapped continuation rows to the agent that started them", () => {
		const long = ` ${"x".repeat(200)}`;
		const hud = new SubagentHudComponent(["", "Subagents", long, "short"], ["Long", "Short"]);
		const rendered = hud.render(40);
		expect(rendered.length).toBeGreaterThan(4);
		const shortRow = rendered.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(shortRow).toBeGreaterThan(3);
		expect(hud.getClickAgentAtRow(2)).toBe("Long");
		expect(hud.getClickAgentAtRow(3)).toBe("Long");
		expect(hud.getClickAgentAtRow(shortRow)).toBe("Short");
		expect(hud.getClickAgentAtRow(shortRow + 1)).toBeUndefined();
	});

	it("maps clicks after wrapping and resizing while leaving clicks before rendering unmapped", () => {
		const hud = new SubagentHudComponent(["", "Subagents", ` ${"x".repeat(100)}`, "short"], ["Long", "Short"]);
		expect(hud.getClickAgentAtRow(2)).toBeUndefined();

		const narrowRows = hud.render(40);
		const narrowShortRow = narrowRows.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(narrowShortRow).toBeGreaterThan(3);
		expect(hud.getClickAgentAtRow(narrowShortRow - 1)).toBe("Long");
		expect(hud.getClickAgentAtRow(narrowShortRow)).toBe("Short");

		const wideRows = hud.render(120);
		expect(wideRows.length).toBeLessThan(narrowRows.length);
		const wideShortRow = wideRows.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(hud.getClickAgentAtRow(wideShortRow)).toBe("Short");
		expect(hud.getClickAgentAtRow(wideShortRow + 1)).toBeUndefined();
	});

	it("remaps clicks when runtime character width changes", () => {
		setHangulCompatibilityJamoWidth(1);
		try {
			const hud = new SubagentHudComponent(["", "Subagents", ` ${"ㅁ".repeat(25)}`, "next"], ["Jamo", "Next"]);
			const narrowRows = hud.render(40);
			const narrowNextRow = narrowRows.findIndex(line => Bun.stripANSI(line).includes("next"));
			expect(hud.getClickAgentAtRow(narrowNextRow)).toBe("Next");

			setHangulCompatibilityJamoWidth(2);
			expect(hud.getClickAgentAtRow(narrowNextRow)).toBe("Next");
			const wideRows = hud.render(40);
			const wideNextRow = wideRows.findIndex(line => Bun.stripANSI(line).includes("next"));
			expect(wideNextRow).toBeGreaterThan(narrowNextRow);
			expect(hud.getClickAgentAtRow(wideNextRow - 1)).toBe("Jamo");
			expect(hud.getClickAgentAtRow(wideNextRow)).toBe("Next");
		} finally {
			resetHangulCompatibilityJamoWidthForTests();
		}
	});
});

describe("layoutPinnedHud", () => {
	it("fits small lists without an expander", () => {
		expect(layoutPinnedHud(0, false)).toEqual({ itemRows: 0, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, false)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, true)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
	});

	it("collapses longer lists behind an expander", () => {
		expect(layoutPinnedHud(4, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
		expect(layoutPinnedHud(10, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
	});

	it("expands to every row with a collapse row", () => {
		expect(layoutPinnedHud(5, true)).toEqual({ itemRows: 5, toggle: "collapse", toggleRow: 7 });
		expect(layoutPinnedHud(10, true)).toEqual({ itemRows: 10, toggle: "collapse", toggleRow: 12 });
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		setSystemTime();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("coalesces a burst of progress observer changes into one HUD rebuild and render request", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const mountHud = vi.spyOn(mode.subagentContainer, "addChild");
		const updateHud = vi.spyOn(SubagentHudComponent.prototype, "update");
		vi.useFakeTimers();

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		// Only the coalesced observer flush: the dock's one-second tick keeps
		// rescheduling while agents run, so running every timer would never end.
		vi.advanceTimersByTime(100);
		await Promise.resolve();

		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("BurstAgent0");
		expect(hud).toContain("BurstAgent3");
		expect(hud).not.toContain("BurstAgent4");
		expect(hud).toContain("2 more — expand");
		expect(mountHud.mock.calls.length + updateHud.mock.calls.length).toBe(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("ticks a running agent's time every second, and stops once no agent is running", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const requestComponentRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});
		vi.useFakeTimers();
		const startedAtMs = Date.now();
		const payload = makeProgressPayload("TickingAgent", 0, "Counting", true);
		payload.progress = { ...payload.progress, toolCount: 2, tokens: 1_500, startedAtMs };
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		const dock = () => Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(dock()).toContain("TickingAgent · 2 tool uses · 1.5k tokens · 0s");

		requestComponentRender.mockClear();
		vi.advanceTimersByTime(2_000);
		expect(dock()).toContain("· 2s");
		expect(requestComponentRender).toHaveBeenCalledWith(mode.subagentContainer);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("TickingAgent", 0, "Counting", true),
			status: "completed",
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		requestComponentRender.mockClear();
		vi.advanceTimersByTime(5_000);
		expect(requestComponentRender).not.toHaveBeenCalledWith(mode.subagentContainer);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not tick for a fork waiting between turns", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			...makeLifecycle("Fork-waiting1", 0, "side chat", true),
			status: "completed",
		});
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("Fork-waiting1");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("applies the setting over a clicked expand override", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		for (let index = 0; index < 5; index++) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle(`Override${index}`, index, `job ${index}`));
		}
		await Promise.resolve();
		const hudText = () => Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));

		mode.togglePinnedHudExpanded();
		expect(hudText()).toContain("Override4");

		mode.applyPinnedAgentsSetting();
		expect(hudText()).not.toContain("Override4");
		expect(hudText()).toContain("more — expand");
	});

	it("scopes steady-state progress repaints to the anchored HUD roots", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const requestComponentRender = vi.spyOn(mode.ui, "requestComponentRender").mockImplementation(() => {});
		vi.useFakeTimers();

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("ScopedAgent", 0, "Starting background work", true));
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		expect(requestRender).toHaveBeenCalledTimes(1);

		requestRender.mockClear();
		requestComponentRender.mockClear();
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("ScopedAgent", 0, "Checking the next prerequisite", true),
		);
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();

		expect(requestRender).not.toHaveBeenCalled();
		expect(requestComponentRender).toHaveBeenCalledTimes(3);
		expect(requestComponentRender).toHaveBeenNthCalledWith(1, mode.statusLine);
		expect(requestComponentRender).toHaveBeenNthCalledWith(2, mode.todoContainer);
		expect(requestComponentRender).toHaveBeenNthCalledWith(3, mode.subagentContainer);
	});

	it("advances a quiet call's elapsed marker by repainting the same HUD in place", async () => {
		cfgDisplaySubagentLivePreview.override(Settings.instance, true);
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		setSystemTime(1_000_000);
		const payload = makeProgressPayload("Sleeper", 0, "Run sleep", true);
		payload.progress = {
			...payload.progress,
			currentTool: "bash",
			currentToolArgs: "sleep 40",
			currentToolStartMs: 1_000_000 - 20_000,
		};
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
		await Promise.resolve();
		vi.advanceTimersByTime(100); // observer UI coalesce window
		const hudText = () => Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		const hud = mode.subagentContainer.children[0];
		expect(hudText()).toContain("bash: sleep 40 · 20.1s");

		vi.advanceTimersByTime(1_000);
		expect(mode.subagentContainer.children[0]).toBe(hud);
		expect(hudText()).toContain("bash: sleep 40 · 21.1s");
	});
});
