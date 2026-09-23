import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	AGENT_ROLE_HEADER,
	buildSideAgentHeaders,
	PARENT_SESSION_ID_HEADER,
	withSideAgentHeaders,
	wrapStreamFnWithSideAgentHeaders,
} from "@oh-my-pi/pi-coding-agent/session/side-agent-headers";

describe("side-agent link headers", () => {
	it("builds the parent id and role headers", () => {
		expect(buildSideAgentHeaders("parent-1", "memory")).toEqual({
			"x-omp-parent-session-id": "parent-1",
			"x-omp-agent-role": "memory",
		});
		expect(buildSideAgentHeaders(undefined, "advisor")).toBeUndefined();
		expect(buildSideAgentHeaders("", "advisor")).toBeUndefined();
	});

	it("merges over caller headers without dropping them, and is a no-op without a parent", () => {
		const options: SimpleStreamOptions = { headers: { "x-caller": "1", [AGENT_ROLE_HEADER]: "stale" } };
		expect(withSideAgentHeaders(options, "parent-1", "subagent")?.headers).toEqual({
			"x-caller": "1",
			[PARENT_SESSION_ID_HEADER]: "parent-1",
			[AGENT_ROLE_HEADER]: "subagent",
		});
		expect(options.headers).toEqual({ "x-caller": "1", [AGENT_ROLE_HEADER]: "stale" });
		expect(withSideAgentHeaders(options, undefined, "subagent")).toBe(options);
		expect(withSideAgentHeaders(undefined, "parent-1", "advisor")?.headers).toEqual({
			[PARENT_SESSION_ID_HEADER]: "parent-1",
			[AGENT_ROLE_HEADER]: "advisor",
		});
	});

	it("reads the parent id per request when wrapping a stream function", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const captured: Array<SimpleStreamOptions | undefined> = [];
		const base: StreamFn = (_m, _ctx, opts) => {
			captured.push(opts);
			throw new Error("capture-stop");
		};
		let parent = "parent-1";
		const wrapped = wrapStreamFnWithSideAgentHeaders(base, () => parent, "advisor");
		const context: Context = { systemPrompt: ["Test"], messages: [] };
		expect(() => wrapped(model, context, undefined)).toThrow("capture-stop");
		parent = "parent-2";
		expect(() => wrapped(model, context, undefined)).toThrow("capture-stop");
		expect(captured.map(opts => opts?.headers?.[PARENT_SESSION_ID_HEADER])).toEqual(["parent-1", "parent-2"]);
	});
});
