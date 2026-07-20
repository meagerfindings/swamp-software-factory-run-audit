# @mgreten/software-factory-run-audit

A deterministic **run reconstruction and invariant-violation audit** for
[`@swamp/software-factory`](https://swamp-club.com) work items. It fires after
the factory's `summary` method and rebuilds one work item's run purely from the
run data the factory already recorded — its state record, its journal, and its
versioned artifact / evidence envelopes — then flags anything that shouldn't be
true. No LLM is involved anywhere: the same run data always produces the same
audit, and every flag carries a source pointer back to the record it came from.

It catches the failure modes you can't eyeball from a summary: a commit SHA that
drifted between the implementation and the draft PR, a gate that was approved
with no prior request, a run that reached `done` with an unresolved verified
critical finding, or a worktree left behind after a run went inactive.

## Installation

```bash
swamp extension pull @mgreten/software-factory-run-audit
swamp extension install
```

## Setup

This is a **report**, not a model — there is nothing to instantiate. Once the
extension is installed, the report activates automatically for any
`@swamp/software-factory` model instance in the repo. It is scoped to the
factory's `summary` method: run the summary and the audit renders alongside it.

```bash
# Run a factory summary for a work item; the run-audit report renders with it.
swamp model method run <your-factory-instance> summary --arg workItem=<work-item-ref>
```

## Usage

The report emits both markdown (human-readable) and JSON (machine-readable). It
reconstructs the run per-era and per-cycle, lists approvals and recorded SHAs,
and raises a flag section:

```markdown
# Run Audit: PROJ-123

**Run status:** terminal · **Current stage:** `done`

2 eras · 1 approvals · 4 findings (0 unresolved) · 1 flag

## Flags

- **[stale-sha]** (high) Recorded commit SHA drifted across the artifact
  lineage: implementation-summary (a1b2…) disagrees with draft-pull-request
  (c3d4…). _(source: artifact draft-pull-request v2)_
```

The optional joins let a caller enrich the audit beyond the run data:

```ts
import { buildAudit, loadAuditData } from "./run_audit_report.ts";

const data = await loadAuditData(reader, "PROJ-123");
const audit = buildAudit(data, "PROJ-123", {
  retainedWorktrees: [
    { identifier: "wt-proj-123", branch: "feature/proj-123", dirty: false },
  ],
  currentHeadSha: "c3d4e5f6...",
});
```

## Global Arguments

None. The report reads only the run data recorded by the factory instance it
attaches to; it takes no configuration.

## Report: run-audit

Scope: `method` (activates on `@swamp/software-factory`'s `summary`).

| Behaviour | Detail |
| --- | --- |
| Trigger | `modelType == @swamp/software-factory` and `methodName == summary` |
| Primary input | `methodArgs.workItem` (the work item to audit) |
| Failure path | Renders the failure reason instead of an empty placeholder |
| Optional joins | `retainedWorktrees`, `linearCorrelation`, `currentHeadSha` — supplied to `buildAudit` by a caller; the report itself passes empties |

## Flags raised

| Kind | Meaning |
| --- | --- |
| `stale-sha` | A commit SHA disagrees across the artifact lineage, or a terminal artifact disagrees with the supplied current HEAD |
| `impossible-state` | A gate approved with no prior request, or `final-validation` / `draft-pull-request` SHA mismatch, or terminal `done` with an unresolved verified blocker |
| `unresolved-blocker` | A findings-shaped artifact carries an unresolved critical/high finding at its latest version |
| `retained-resource` | A worktree join shows a resource retained past an inactive run or left dirty |

## How It Works

The report replays the factory's **journal** — the ordered event log the state
machine writes — into eras (start + resets) and per-stage cycles, attaching the
recorded SHAs and findings from each artifact version to the cycle that produced
them. It then walks a fixed artifact **lineage** (implementation → test →
browser → final-validation → draft-PR, with patched/final variants) and raises
the flags above. Malformed or garbage-collected records are skipped and the
audit is marked truncated rather than crashing.

The retained-worktree join and the external issue-tracker (Linear) correlation
join are **optional and pluggable** — they are cross-model reads the report
context cannot perform on its own, so a caller or test harness supplies them to
`buildAudit` directly. Absent them, the audit degrades gracefully to the
run-data-only view.

The report is deliberately zero-dependency and zod-free so it bundles cleanly as
a report extension (report bundles are built without the extension import map).

## License

MIT — see LICENSE for details.
