# Intelligence Hub telemetry hooks (Avanade fork)

These hooks send Elephant-Goldfish Model (EGM) usage to the Intelligence Hub collector
(Governança › SDLC › Developers › Google Elephant-Goldfish Model, and the SDD & Skills group
of each SDLC project), under the contract `egm.telemetry.contract = 1`. They are the only
change of this fork against `google/elephant-goldfish-model`, kept in their own files so
upstream syncs merge cleanly.

| File | Host |
|---|---|
| `hooks/hooks.json` | Claude Code, when EGM is installed from this fork's marketplace |
| `hooks/aap-telemetry/hook.mjs` | the hook itself (Node 18+, no dependencies) |
| `hooks/aap-telemetry/install.mjs` | the one-command installer (`npx`), for GitHub Copilot or the stock plugin |

`scripts/pack_plugin.py` packages `hooks/` into `distributions/claude`, so the published
Claude runtime carries them (the manifest has no `hooks` field: Claude Code reads
`hooks/hooks.json` by convention).

## Setup

1. Run the IDE setup script from the project's link page in the Intelligence Hub. It sets
   `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` (the `dtl_` token) that the
   hook reads. Without them the hook does nothing.
2. Claude Code: install EGM from this fork, which already runs the hooks:

   ```bash
   claude plugin marketplace add Ava-Group-OCTO-AIPlatform/elephant-goldfish-model
   claude plugin install egm@egm
   ```

   Remove the stock plugin first if you had it (`claude plugin uninstall egm@egm`, then
   `claude plugin marketplace remove egm`).
3. GitHub Copilot (CLI or VS Code agent hooks), or the stock plugin in Claude Code: from the
   repository root (Node 18+):

   ```bash
   npx -y github:Ava-Group-OCTO-AIPlatform/elephant-goldfish-model            # this repository + Claude Code (user)
   npx -y github:Ava-Group-OCTO-AIPlatform/elephant-goldfish-model --repo     # this repository only (commit .github/hooks)
   npx -y github:Ava-Group-OCTO-AIPlatform/elephant-goldfish-model --user     # Claude Code, every repository
   npx -y github:Ava-Group-OCTO-AIPlatform/elephant-goldfish-model --uninstall
   ```

   Do not use `--user` together with the fork plugin of step 2: both would send each event.
4. Restart the IDE so the hooks and the environment are picked up.

Opt out at any time with `AAP_EGM_TELEMETRY=off`. Failed sends wait in `~/.aap-egm/outbox.jsonl`
(at most 1000 events) and go with the next hook.

## What is sent

Only hashes, enums and counts: the session id and a design document id are SHA-256 of the
repository and the id or relative path, cut to 32 hex; skills and reviewers only when they are
EGM catalog names; artifacts as a kind from the file names EGM writes. No prompt, path, file
name or text: a review report is read on the machine only to count its findings by severity.

| Event | When |
|---|---|
| `egm.session.start` / `egm.session.end` | the session starts / ends (duration, end reason) |
| `egm.skill.invoke` | an EGM skill runs (`/egm:egm-brainstorm`, `egm-draft`, `egm-review`, `egm-resolve`, `egm-review-loop`, `egm-bootstrap`, `egm-drift-report`); only the command name is read from the prompt |
| `egm.goldfish.invoke` | an EGM subagent starts (`egm-zoom-out`, `egm-comprehension`, `egm-design`, `egm-implementation-readiness`, ...) |
| `egm.artifact.write` | EGM writes `concepts_brief.md`, `discussion_summary.md`, `design_draft.md`, `docs/designs/*.md`, a reviewer report, `goldfish_review_report.md` / `consolidated_review_report.md` (with its Blocker, Major and Nit counts) or a drift report; once per file and session |

The full contract is in the Intelligence Hub repository, `src/features/dev-telemetry/egm/contract.ts`.
