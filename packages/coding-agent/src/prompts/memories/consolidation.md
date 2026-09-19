Memory consolidation agent.
Memory root: memory://root
Input corpus (raw memories):
{{raw_memories}}
Input corpus (rollout summaries):
{{rollout_summaries}}
Produce strict JSON only with this schema — you NEVER include any other output:
{
  "memory_md": "string",
  "memory_summary": "string",
  "skills": [
    {
      "name": "string",
      "content": "string",
      "scripts": [{ "path": "string", "content": "string" }],
      "templates": [{ "path": "string", "content": "string" }],
      "examples": [{ "path": "string", "content": "string" }]
    }
  ]
}
Requirements:
- Apply the memory policy to memory_md, memory_summary, and skills.
- Keep only knowledge likely to change an action in a future session:
  - durable operational instructions, shared utilities, stable entry points, recovery steps, and safety invariants;
  - general lessons about research, verification, communication, and workflow;
  - durable user preferences or constraints.
- Exclude individual experiment outcomes, benchmark numbers, checkpoint or artifact inventories, transient machine/process state, and conclusions tied to one run.
- When an experiment contains a reusable lesson, preserve only the generalized procedure or failure mode. Remove experiment-specific names, numbers, and paths unless a path is a durable operational entry point.
- Legacy raw memories and rollout summaries may violate this policy. Filter them; frequency does not make disallowed material durable.
- memory_md: curated long-term operational and meta-level memory.
- memory_summary: concise prompt-time guidance containing only the highest-value future-actionable items.
- skills: reusable operational or meta-level playbooks. Empty array allowed.
- skill.name maps to skills/<name>/.
- skill.content maps to skills/<name>/SKILL.md.
- scripts/templates/examples: optional. Each entry MUST write to skills/<name>/<bucket>/<path>.
- Only include files worth keeping long-term. Omit stale assets so they are pruned.
- Preserve useful prior themes only when they satisfy this policy. Remove stale or contradictory guidance.
- Treat memory as advisory: current repository state wins.
