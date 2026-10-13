import { describe, expect, it } from "bun:test";
import { NativeToolLinks, type NativeToolClick } from "../src/native-tool-links";
import { StdinBuffer } from "../src/stdin-buffer";

const PREFIX = "\x1b[>997;";
const CLOSE = "\x1b]8;;\x1b\\";

function harness() {
	const writes: string[] = [];
	const clicks: NativeToolClick[] = [];
	let readyCount = 0;
	const links = new NativeToolLinks(
		data => writes.push(data),
		() => readyCount++,
		click => clicks.push(click),
	);
	links.start();
	return { links, writes, clicks, readyCount: () => readyCount };
}

describe("native tool links", () => {
	it("requires a matching companion nonce before replacing mouse capture", () => {
		const h = harness();
		const owner = {};
		expect(h.links.nonce).toMatch(/^[0-9]{39}$/);
		expect(h.writes[0]).toBe(
			`\x1b]1337;SetUserVar=omp_tool_instance=${Buffer.from(h.links.nonce).toString("base64")}\x07`,
		);
		expect(h.links.decorate("tool", owner)).toBe("tool");
		const other = harness();
		expect(h.links.consume(`${PREFIX}1;${other.links.nonce}u`)).toBe("");
		expect(h.links.ready).toBe(false);
		h.links.consume(`${PREFIX}1;${h.links.nonce}u`);
		h.links.consume(`${PREFIX}1;${h.links.nonce}u`);
		expect(h.links.ready).toBe(true);
		expect(h.readyCount()).toBe(1);
		h.links.stop();
		expect(h.links.ready).toBe(false);
		expect(h.writes.at(-1)).toBe("\x1b]1337;SetUserVar=omp_tool_instance=\x07");
		h.links.consume(`${PREFIX}1;${h.links.nonce}u`);
		expect(h.links.ready).toBe(false);
	});

	it("retains owner identity across rows and preserves inner external hyperlinks", () => {
		const h = harness();
		h.links.consume(`${PREFIX}1;${h.links.nonce}u`);
		const owner = {};
		const first = h.links.decorate("header", owner);
		const url = first.match(/omp-tool:\/\/[0-9]+\/[0-9]+/)![0];
		expect(h.links.decorate("different reflowed row", owner)).toContain(url);
		expect(h.links.decorate("other tool", {})).not.toContain(`${url}\x1b`);
		expect(h.links.decorate("  ", owner)).toBe("  ");
		const open = first.slice(0, first.indexOf("header"));
		const external = "\x1b]8;id=source;https://example.com\x07source\x1b]8;;\x07";
		const nested = h.links.decorate(`before ${external} after`, owner);
		expect(nested).toBe(`${open}before ${external}${open} after${CLOSE}`);
		const id = url.split("/").at(-1)!;
		h.links.consume(`${PREFIX}2;${h.links.nonce};${id};12u`);
		expect(h.clicks).toEqual([{ owner, id, request: "12" }]);
		expect(h.writes).toHaveLength(1);
		h.links.acknowledge(h.clicks[0]!);
		expect(h.writes.at(-1)).toBe(
			`\x1b]1337;SetUserVar=omp_tool_ack=${Buffer.from(`${h.links.nonce}:${id}:12`).toString("base64")}\x07`,
		);
	});

	it("consumes stale and unknown-owner clicks without turning them into editor input", () => {
		const h = harness();
		const other = harness();
		h.links.consume(`${PREFIX}1;${h.links.nonce}u`);
		expect(h.links.consume(`a${PREFIX}2;${other.links.nonce};1;1ub`)).toBe("ab");
		expect(h.clicks).toHaveLength(0);
		expect(h.links.consume(`${PREFIX}2;${h.links.nonce};999;2u`)).toBe("");
		expect(h.clicks).toEqual([{ owner: undefined, id: "999", request: "2" }]);
	});

	it("handles split packet bodies, coalesced input, and oversized reports with bounded buffering", () => {
		const h = harness();
		const packet = `${PREFIX}1;${h.links.nonce}u`;
		for (let split = PREFIX.length; split < packet.length; split++) {
			expect(h.links.consume(packet.slice(0, split))).toBe("");
			expect(h.links.consume(packet.slice(split))).toBe("");
		}
		expect(h.readyCount()).toBe(1);
		expect(h.links.consume(`a${PREFIX}${"1".repeat(512)}`)).toBe("a");
		expect(h.links.consume(`${"1".repeat(512)}ub${packet}c`)).toBe("bc");
		expect(h.links.consume("\x1b[A\x1b")).toBe("\x1b[A\x1b");
		expect(h.links.consume(`${PREFIX}1;${h.links.nonce}mtext`)).toBe("text");
	});

	it("leaves bracketed paste opaque even if it contains the private wire format", () => {
		const h = harness();
		const pasted = `\x1b[200~${PREFIX}1;${h.links.nonce}u\x1b[201~`;
		expect(h.links.consume(pasted)).toBe(pasted);
		expect(h.links.ready).toBe(false);
	});
});

it("assembles native reports split at every byte boundary before the editor sees input", () => {
	const h = harness();
	const input: string[] = [];
	const buffer = new StdinBuffer({ timeout: 1000 });
	buffer.on("data", (sequence: string) => {
		const remaining = h.links.consume(sequence);
		if (remaining) input.push(remaining);
	});
	try {
		const report = `${PREFIX}1;${h.links.nonce}u`;
		for (let split = 1; split < report.length; split++) {
			buffer.process(report.slice(0, split));
			buffer.process(report.slice(split));
		}
		expect(h.readyCount()).toBe(1);
		expect(input).toEqual([]);
		buffer.process("hello");
		expect(input.join("")).toBe("hello");
	} finally {
		buffer.destroy();
	}
});
