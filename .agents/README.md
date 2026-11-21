# Memory Bank

Schema and maintenance rules for this project's `.agents/` memory bank.

- `state.md` — always-current status. Rewrite with: Goal, Progress, Blockers, Next actions.
  It describes the code as it now is, not a plan. Update it last, after code and docs land.
- `memory.md` — persistent knowledge. Append `## YYYY-MM-DD — <topic>` entries. Keep architectural
  decisions and why, gotchas with their symptom, environment facts, and non-obvious conventions.
  Never delete or rewrite prior entries; supersede a wrong entry by appending a newer one.
- `AGENTS.md` (this folder) — memory-bank-local rules.

Session start: read `.agents/state.md`, then `.agents/memory.md`, then root `AGENTS.md`.
After a large verified task: run the **sync** skill to append memory and rewrite state.

No secrets, tokens, or private URLs in memory files. Use `~` for home paths.
