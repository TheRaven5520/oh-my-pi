import type { CentralChat, CentralRequest } from "./types";

export interface CentralQueueEntry<T> {
	key: string;
	chat: CentralChat;
	request: CentralRequest;
	draft?: T;
}

/** A chat gets one turn, not one turn per question. Refresh never interrupts a live turn. */
export class CentralQueue<T = unknown> {
	#order: string[] = [];
	#entries = new Map<string, CentralQueueEntry<T>>();
	#accepted = new Set<string>();

	get current(): CentralQueueEntry<T> | undefined {
		const chatId = this.#order[0];
		for (const entry of this.#entries.values()) if (entry.chat.id === chatId) return entry;
		return undefined;
	}

	get chatCount(): number {
		return this.#order.length;
	}

	get entries(): IterableIterator<CentralQueueEntry<T>> {
		return this.#entries.values();
	}
	get orderedChatIds(): readonly string[] {
		return this.#order;
	}

	entryForChat(chatId: string): CentralQueueEntry<T> | undefined {
		for (const entry of this.#entries.values()) if (entry.chat.id === chatId) return entry;
		return undefined;
	}

	has(entry: CentralQueueEntry<T>): boolean {
		return this.#entries.get(entry.key) === entry;
	}

	/** Returns retired drafts so the UI can release their resources. IDs identify immutable requests. */
	update(chats: readonly CentralChat[]): CentralQueueEntry<T>[] {
		const previous = this.current;
		const next = new Map<string, CentralQueueEntry<T>>();
		const pendingChats = new Set<string>();
		const seen = new Set<string>();
		for (const chat of chats) {
			for (const request of [...chat.requests].sort((a, b) => a.createdAt - b.createdAt)) {
				const key = JSON.stringify([chat.id, request.id]);
				seen.add(key);
				if (this.#accepted.has(key)) continue;
				const entry = this.#entries.get(key) ?? { key, chat, request };
				entry.chat = chat;
				next.set(key, entry);
				pendingChats.add(chat.id);
			}
		}
		for (const key of this.#accepted) if (!seen.has(key)) this.#accepted.delete(key);
		const retired = [...this.#entries.values()].filter(entry => !next.has(entry.key));
		this.#order = this.#order.filter(id => pendingChats.has(id));
		for (const id of pendingChats) if (!this.#order.includes(id)) this.#order.push(id);
		if (previous && next.has(previous.key)) {
			// Even a backdated arrival in this chat cannot replace the question being read.
			this.#entries = new Map([[previous.key, previous], ...next]);
		} else this.#entries = next;
		// A replacement is a new turn: the next waiting chat should not be starved by it.
		if (previous && !next.has(previous.key) && this.#order[0] === previous.chat.id) this.skip();
		return retired;
	}

	skip(chatId?: string): void {
		const id = chatId ?? this.#order[0];
		if (id === undefined) return;
		const index = this.#order.indexOf(id);
		if (index < 0) return;
		this.#order.splice(index, 1);
		this.#order.push(id);
	}

	/** Hide an accepted request immediately, including from an already in-flight stale refresh. */
	accept(entry: CentralQueueEntry<T>): void {
		this.#accepted.add(entry.key);
		const wasCurrent = this.current === entry;
		this.#entries.delete(entry.key);
		if (![...this.#entries.values()].some(other => other.chat.id === entry.chat.id)) {
			this.#order = this.#order.filter(id => id !== entry.chat.id);
		} else if (wasCurrent) this.skip();
	}
}
