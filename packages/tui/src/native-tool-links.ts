import { randomBytes } from "node:crypto";

const PREFIX = "\x1b[>997;";
const MAX_PACKET = 128;
const OSC8_CLOSE = "\x1b]8;;\x1b\\";

function userVariable(name: string, value: string): string {
	return `\x1b]1337;SetUserVar=${name}=${Buffer.from(value).toString("base64")}\x07`;
}

export interface NativeToolClick {
	readonly owner: object | undefined;
	readonly id: string;
	readonly request: string;
}

/**
 * Direct-terminal tool links. The Kitty companion must echo the per-start nonce
 * before links replace DEC mouse capture. OSC 1337 values and OSC 8 URLs are
 * terminal-local; none contain a command, socket path, or executable payload.
 *
 * Wire: CSI >997;1;<nonce>u announces readiness; >997;2;<nonce>;<id>;<request>u
 * clicks a link. Parameters are decimal so the existing stdin CSI assembler
 * cannot mistake a hex/base36 letter for a final byte. Replies publish
 * omp_tool_ack=base64(nonce:id:request), after the completed replay write.
 */
export class NativeToolLinks {
	readonly nonce = BigInt(`0x${randomBytes(16).toString("hex")}`)
		.toString()
		.padStart(39, "0");
	#active = false;
	#ready = false;
	#nextId = 0;
	#ids = new WeakMap<object, string>();
	#owners = new Map<string, WeakRef<object>>();
	#collected = new FinalizationRegistry<string>(id => this.#owners.delete(id));
	#partial = "";
	#discarding = false;

	constructor(
		private readonly write: (data: string) => void,
		private readonly onReady: () => void,
		private readonly onClick: (click: NativeToolClick) => void,
	) {}

	get ready(): boolean {
		return this.#active && this.#ready;
	}

	start(): void {
		this.#active = true;
		this.write(userVariable("omp_tool_instance", this.nonce));
	}

	stop(): void {
		if (this.#active) this.write(userVariable("omp_tool_instance", ""));
		this.#active = false;
		this.#ready = false;
		this.#partial = "";
		this.#discarding = false;
		this.#owners.clear();
	}

	acknowledge(click: NativeToolClick): void {
		if (this.ready) this.write(userVariable("omp_tool_ack", `${this.nonce}:${click.id}:${click.request}`));
	}

	/** Weak identities survive reflow/replay without retaining discarded tools. */
	decorate(line: string, owner: object): string {
		if (!this.ready || line.trim() === "") return line;
		let id = this.#ids.get(owner);
		if (id === undefined) {
			id = String(++this.#nextId);
			this.#ids.set(owner, id);
			this.#owners.set(id, new WeakRef(owner));
			this.#collected.register(owner, id);
		}
		const open = `\x1b]8;id=omp-${this.nonce}-${id};omp-tool://${this.nonce}/${id}\x1b\\`;
		// OSC 8 does not nest. Keep real URLs intact and restore the row's tool
		// target when an inner URL closes; always close before the row terminator.
		return (
			open +
			line.replace(
				/\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g,
				(sequence, _params: string, uri: string) => (uri === "" ? sequence + open : sequence),
			) +
			OSC8_CLOSE
		);
	}

	/**
	 * StdinBuffer already assembles CSI sequences. Also tolerate split packet
	 * bodies from custom Terminal implementations; retain at most MAX_PACKET
	 * bytes and discard oversized reports through their CSI final byte. Bare
	 * Escape and unrelated CSI input are never delayed, and paste is opaque.
	 */
	consume(data: string): string {
		if (data.startsWith("\x1b[200~")) return data;
		let output = "";
		let offset = 0;
		while (offset < data.length) {
			if (this.#partial === "" && !this.#discarding) {
				const begin = data.indexOf(PREFIX, offset);
				if (begin < 0) return output + data.slice(offset);
				output += data.slice(offset, begin);
				offset = begin + PREFIX.length;
				this.#partial = PREFIX;
			}
			while (offset < data.length) {
				const char = data[offset++]!;
				const code = char.charCodeAt(0);
				if (!this.#discarding) {
					this.#partial += char;
					if (this.#partial.length > MAX_PACKET) {
						this.#partial = "";
						this.#discarding = true;
					}
				}
				if (code >= 0x40 && code <= 0x7e) {
					const packet = this.#partial;
					this.#partial = "";
					this.#discarding = false;
					this.#dispatch(packet);
					break;
				}
			}
		}
		return output;
	}

	#dispatch(packet: string): void {
		if (!this.#active) return;
		const ready = /^\x1b\[>997;1;([0-9]{39})u$/.exec(packet);
		if (ready?.[1] === this.nonce) {
			if (!this.#ready) {
				this.#ready = true;
				this.onReady();
			}
			return;
		}
		const click = /^\x1b\[>997;2;([0-9]{39});([0-9]{1,16});([0-9]{1,16})u$/.exec(packet);
		if (!this.ready || click?.[1] !== this.nonce) return;
		const id = click[2]!;
		this.onClick({ owner: this.#owners.get(id)?.deref(), id, request: click[3]! });
	}
}
