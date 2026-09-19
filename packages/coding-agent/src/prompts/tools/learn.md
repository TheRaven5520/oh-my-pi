Capture reusable lessons in long-term memory; optionally mint/enhance a managed skill in the same call.

Use only for knowledge likely to change an action in a future session:
- durable operational knowledge, reusable utilities, stable entry points, recovery steps, or safety invariants;
- durable user preferences or constraints;
- general lessons about research, verification, communication, or workflow.

NEVER store individual experiment results, measurements, checkpoints, artifact inventories, transient machine/process state, or conclusions tied to one run. An experiment may yield a lesson, but capture only the generalized procedure or failure mode without experiment-specific names, numbers, or paths. Keep a path only when it is a durable operational entry point or shared utility.

`skill` optional; provide only for a repeatable procedure worth codifying as `SKILL.md`, not a fact. Managed skills: isolated `~/.omp/agent/managed-skills`; surfaced as normal skills next session; NEVER touch user-authored skills. Frontmatter: generated from `name` and `description`.

Capture sparingly, specifically: one strong reusable lesson > several vague ones.
