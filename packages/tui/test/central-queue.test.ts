import { describe, expect, it } from "bun:test";
import { CentralQueue } from "../src/apps/central/queue";
import type { CentralChat, CentralRequest } from "../src/apps/central/types";

function request(id: string, createdAt = 1): CentralRequest {
	return { id, createdAt, kind: "editor", title: `Question ${id}` };
}

function chat(id: string, requests = [request(id)]): CentralChat {
	return { id, sessionId: id, name: id, pid: 1, cwd: "/", busy: false, requests };
}

describe("CentralQueue", () => {
	it("rotates whole chats fairly rather than their individual requests", () => {
		const queue = new CentralQueue();
		queue.update([chat("a", [request("a1"), request("a2", 2)]), chat("b"), chat("c")]);
		expect(queue.current?.request.id).toBe("a1");
		queue.skip();
		expect(queue.current?.chat.id).toBe("b");
		queue.skip();
		expect(queue.current?.chat.id).toBe("c");
		queue.skip();
		expect(queue.current?.request.id).toBe("a1");
		expect(queue.chatCount).toBe(3);
	});

	it("preserves per-chat FIFO and gives another chat the turn after acceptance", () => {
		const queue = new CentralQueue();
		queue.update([chat("a", [request("later", 3), request("first", 1)]), chat("b")]);
		expect(queue.current?.request.id).toBe("first");
		queue.accept(queue.current!);
		expect(queue.current?.chat.id).toBe("b");
		queue.skip();
		expect(queue.current?.request.id).toBe("later");
	});

	it("advances when the original chat answers, without keeping its stale draft", () => {
		const queue = new CentralQueue<{ text: string }>();
		queue.update([chat("a"), chat("b")]);
		const original = queue.current!;
		original.draft = { text: "not sent" };
		const retired = queue.update([chat("a", []), chat("b")]);
		expect(queue.current?.chat.id).toBe("b");
		expect(retired).toEqual([original]);
		expect(retired[0]?.draft?.text).toBe("not sent");
		expect(queue.has(original)).toBe(false);
	});

	it("does not let new chats, reordering, or backdated requests steal focus", () => {
		const queue = new CentralQueue();
		queue.update([chat("a", [request("reading", 5)]), chat("b")]);
		const original = queue.current;
		queue.update([chat("new"), chat("b"), chat("a", [request("early", 1), request("reading", 5)])]);
		expect(queue.current).toBe(original);
		queue.skip();
		expect(queue.current?.chat.id).toBe("b");
		queue.skip();
		expect(queue.current?.chat.id).toBe("new");
	});

	it("retains form objects across skip and ordinary refresh", () => {
		const queue = new CentralQueue<{ text: string; choices: number[] }>();
		queue.update([chat("a"), chat("b")]);
		const draft = { text: "Other answer in progress", choices: [1, 3] };
		queue.current!.draft = draft;
		queue.skip();
		queue.update([chat("a"), chat("b")]);
		queue.skip();
		expect(queue.current?.draft).toBe(draft);
	});

	it("resets replaced requests and moves their chat behind the waiting chat", () => {
		const queue = new CentralQueue<string>();
		queue.update([chat("a"), chat("b")]);
		queue.current!.draft = "old answer";
		expect(queue.update([chat("a", [request("replacement")]), chat("b")])).toHaveLength(1);
		expect(queue.current?.chat.id).toBe("b");
		queue.skip();
		expect(queue.current?.request.id).toBe("replacement");
		expect(queue.current?.draft).toBeUndefined();
	});

	it("does not resurrect an accepted request from a stale in-flight snapshot", () => {
		const queue = new CentralQueue();
		const snapshot = [chat("a"), chat("b")];
		queue.update(snapshot);
		queue.accept(queue.current!);
		queue.update(snapshot);
		expect(queue.current?.chat.id).toBe("b");
		expect(queue.chatCount).toBe(1);
	});

	it("keeps pending questions visible while the process is busy", () => {
		const queue = new CentralQueue();
		queue.update([{ ...chat("a"), busy: true }]);
		expect(queue.current?.chat.id).toBe("a");
		queue.skip();
		expect(queue.current?.chat.id).toBe("a");
		queue.update([]);
		expect(queue.current).toBeUndefined();
		expect(queue.chatCount).toBe(0);
		queue.skip();
		expect(queue.current).toBeUndefined();
	});
});
