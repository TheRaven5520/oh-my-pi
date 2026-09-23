/** `/fork` chats register as `Fork-<snowflake>` agents with `<id>.jsonl` transcripts in the parent artifacts dir. */
const FORK_ID_PATTERN = /^Fork-[A-Za-z0-9_-]+$/;

/** Whether an agent id belongs to a `/fork` chat. */
export function isForkAgentId(id: string): boolean {
	return FORK_ID_PATTERN.test(id);
}

/** Whether a transcript file name belongs to a `/fork` chat, which its controller owns rather than the resume scan. */
export function isForkTranscriptName(name: string): boolean {
	return name.endsWith(".jsonl") && isForkAgentId(name.slice(0, -".jsonl".length));
}
