import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { learnToolRenderer, type LearnDetails } from "@oh-my-pi/pi-tui/tools/learn";

const ui: ToolExecutionUi = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
const args = {
	memory: "Preserve the deployed runtime.\n\nRead the live configuration before replacing binaries.",
	context: "## Source\nA deploy review found a configuration mismatch.",
	skill: {
		action: "create",
		name: "safe-deploy",
		description: "Use before replacing a deployed runtime.",
		body: "## Procedure\n1. Read live configuration.\n2. Keep a rollback binary.",
	},
};
const options = { expanded: false, isPartial: false };
const stored: LearnDetails = {
	skill: "safe-deploy",
	memory: { status: "stored", backend: "local", scope: "project" },
	skillOperation: {
		action: "create",
		name: "safe-deploy",
		outcome: "created",
		path: "/isolated/managed-skills/safe-deploy/SKILL.md",
	},
};
const output = (text: string, details?: LearnDetails, isError = false) => ({
	content: [{ type: "text", text }],
	details,
	isError,
});
const rows = (card: ToolExecutionComponent) => card.render(160).map(line => Bun.stripANSI(line));

// These tests only render synthetic payloads. They never invoke a memory backend or write a skill.
describe("Learn semantic presentation", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("expands an existing renderer component without recreating it", () => {
		const mutableOptions = { expanded: false, isPartial: false };
		const component = learnToolRenderer.renderResult(
			output("Lesson stored. Created managed skill safe-deploy.", stored),
			mutableOptions,
			theme,
			args,
		);
		const collapsed = Bun.stripANSI(component.render(160).join("\n"));
		expect(collapsed).not.toContain("rollback binary");
		mutableOptions.expanded = true;
		const expanded = Bun.stripANSI(component.render(160).join("\n"));
		expect(expanded).toContain("rollback binary");
		expect(expanded).toContain("configuration mismatch");
		expect(expanded).toContain(stored.skillOperation!.path!);
		mutableOptions.expanded = false;
		expect(Bun.stripANSI(component.render(160).join("\n"))).toBe(collapsed);
	});

	it("keeps streamed requests concise without claiming persistence or skill creation", () => {
		const card = new ToolExecutionComponent("learn", {}, {}, undefined, ui, "/tmp");
		try {
			expect(rows(card).join("\n")).not.toContain("stored");
			card.updateArgs({ memory: args.memory, skill: { action: "create" } });
			const pending = rows(card);
			expect(pending[0]).toContain("Learn");
			expect(pending[0]).not.toContain("Preserve the deployed runtime");
			expect(pending.join("\n")).toContain("Preserve the deployed runtime.");
			expect(pending.join("\n")).toContain("Skill requested");
			expect(pending.join("\n")).not.toContain("Read the live configuration");
			expect(pending.join("\n")).not.toContain("Skill created");
			card.updateArgs(args);
			expect(rows(card).join("\n")).toContain("safe-deploy");
		} finally {
			card.seal();
		}
	});

	it.each(["stored", "queued"] as const)(
		"renders observed %s status and never derives a skill outcome from arguments",
		status => {
			const details: LearnDetails = {
				skill: null,
				memory: { status, backend: status === "queued" ? "hindsight" : "mnemopi", scope: "global" },
			};
			const result = output(`Lesson ${status}.`, details);
			const summary = learnToolRenderer.activitySummary(args, { ...options, result });
			expect(summary.detail).toBe(status);
			expect(summary.meta).toBe(`${details.memory.backend} · global`);
			expect(summary.preview).toEqual(["Preserve the deployed runtime."]);
			const card = new ToolExecutionComponent("learn", args, {}, undefined, ui, "/tmp");
			try {
				card.updateResult(result, false);
				const rendered = rows(card);
				expect(rendered[0]).toContain(status);
				expect(rendered[0]).toContain(details.memory.backend);
				expect(rendered.join("\n")).not.toContain("Skill created");
				if (status === "queued") expect(rendered.join("\n")).not.toContain("stored");
			} finally {
				card.seal();
			}
		},
	);

	it("shows actual skill identity, not the requested name, and expands all original content", () => {
		const result = output("Lesson stored. Created managed skill safe-deploy.", stored);
		const card = new ToolExecutionComponent("learn", args, {}, undefined, ui, "/tmp");
		try {
			card.updateResult(result, false);
			const collapsed = rows(card).join("\n");
			expect(collapsed).toContain("Skill created");
			expect(collapsed).not.toContain("rollback binary");
			card.setExpanded(true);
			const expanded = rows(card).join("\n");
			for (const content of [
				"configuration mismatch",
				"Read the live configuration",
				"rollback binary",
				"Use before replacing",
				stored.skillOperation!.path!,
			]) {
				expect(expanded).toContain(content);
			}
			card.setExpanded(false);
			expect(rows(card).join("\n")).toBe(collapsed);
		} finally {
			card.seal();
		}
		const summary = learnToolRenderer.activitySummary(
			{ ...args, skill: { ...args.skill, name: "requested-name" } },
			{ ...options, result },
		);
		expect(summary.preview).toContain("Skill created · safe-deploy");
		expect(summary.preview?.join("\n")).not.toContain("requested-name");
	});

	it.each(["stored", "queued"] as const)("keeps memory %s and skill failure visible together", status => {
		const details: LearnDetails = {
			skill: null,
			memory: { status, backend: status === "stored" ? "local" : "hindsight", scope: "project" },
			skillOperation: { action: "create", name: "safe-deploy", outcome: "failed", error: "permission denied" },
		};
		const result = output(
			`Lesson ${status}, but the managed skill could not be written: permission denied`,
			details,
			true,
		);
		const summary = learnToolRenderer.activitySummary(args, { ...options, result });
		expect(summary.preview).toBeUndefined();
		expect(summary.error).toContain("permission denied");
		const card = new ToolExecutionComponent("learn", args, {}, undefined, ui, "/tmp");
		try {
			card.updateResult(result, false);
			for (const expanded of [false, true]) {
				card.setExpanded(expanded);
				const rendered = rows(card).join("\n");
				expect(rendered).toContain(status);
				expect(rendered).toContain("permission denied");
				expect(rendered).not.toContain("Skill created");
			}
		} finally {
			card.seal();
		}
	});

	it("retains historical result text rather than inferring outcomes from old details", () => {
		const result = {
			content: [{ type: "text", text: "Original backend receipt with an important warning." }],
			details: { skill: "safe-deploy" },
		};
		const summary = learnToolRenderer.activitySummary(args, { ...options, result });
		expect(summary.preview).toBeUndefined();
		expect(summary.detail).toBeUndefined();
		const card = new ToolExecutionComponent("learn", args, {}, undefined, ui, "/tmp");
		try {
			card.updateResult(result, false);
			expect(rows(card).join("\n")).toContain("important warning");
			expect(rows(card).join("\n")).not.toContain("Skill created");
		} finally {
			card.seal();
		}
	});

	it("preserves complete Markdown in the native expanded view but not the compact request", () => {
		const compact = learnToolRenderer.describeCall(args, options);
		expect(JSON.stringify(compact.body)).not.toContain("rollback binary");
		const expanded = learnToolRenderer.describeCall(args, { ...options, expanded: true });
		const markdown = expanded.body?.filter(
			node => typeof node === "object" && node !== null && "k" in node && node.k === "md",
		);
		expect(markdown).toHaveLength(3);
		for (const source of [args.memory, args.context, args.skill.body]) {
			expect(JSON.stringify(markdown)).toContain(JSON.stringify(source).slice(1, -1));
		}
	});
});
