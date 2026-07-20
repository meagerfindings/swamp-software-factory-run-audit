import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.14";
import {
  type AuditData,
  buildAudit,
  loadAuditData,
  renderAuditMarkdown,
  type RunDataReader,
  workItemSlug,
} from "./run_audit_report.ts";

// ---------------------------------------------------------------------------
// Hand-built fixture run data. buildAudit is pure over an AuditData, so the
// tests construct the state / journal / artifact maps directly — no live
// datastore, no chat/transcript input. This establishes the report test
// pattern (there is no existing report test to copy).
// ---------------------------------------------------------------------------

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

interface ArtifactSpec {
  name: string;
  version: number;
  payload: Record<string, unknown>;
  stageId?: string;
  cycle?: number;
}

function artifactEnvelope(spec: ArtifactSpec) {
  return {
    name: spec.name,
    workItem: "WI-500",
    stageId: spec.stageId ?? "implementation",
    cycle: spec.cycle ?? 1,
    payload: spec.payload,
    recordedAt: "2026-07-18T00:00:00.000Z",
  };
}

function journal(
  events: Array<
    {
      event: string;
      payload?: Record<string, unknown>;
      at?: string;
      stageId?: string;
    }
  >,
): AuditData["journal"] {
  return events.map((e, index) => ({
    version: index + 1,
    entry: {
      event: e.event,
      workItem: "WI-500",
      stageId: e.stageId,
      summary: `${e.event}`,
      payload: e.payload,
      at: e.at ?? `2026-07-18T00:0${index}:00.000Z`,
    },
  }));
}

function auditData(opts: {
  status?: "active" | "terminal";
  stageId?: string;
  journal: AuditData["journal"];
  artifacts?: ArtifactSpec[];
  journalTruncated?: boolean;
}): AuditData {
  const artifactVersions = new Map<
    string,
    Map<number, ReturnType<typeof artifactEnvelope>>
  >();
  for (const spec of opts.artifacts ?? []) {
    const perVersion = artifactVersions.get(spec.name) ?? new Map();
    perVersion.set(spec.version, artifactEnvelope(spec));
    artifactVersions.set(spec.name, perVersion);
  }
  return {
    slug: "WI-500",
    state: {
      workItem: "WI-500",
      stageId: opts.stageId ?? "implementation",
      cycles: {},
      enteredAt: "2026-07-18T00:00:00.000Z",
      status: opts.status ?? "active",
      definitionVersion: 1,
      startedAt: "2026-07-18T00:00:00.000Z",
    },
    journal: opts.journal,
    journalTruncated: opts.journalTruncated ?? false,
    // deno-lint-ignore no-explicit-any
    artifactVersions: artifactVersions as any,
    evidenceVersions: new Map(),
  };
}

function everyFlagHasSource(
  flags: { source?: { kind: string; name: string } }[],
) {
  for (const flag of flags) {
    assert(flag.source !== undefined, "a flag is missing its source pointer");
    assert(typeof flag.source.kind === "string" && flag.source.kind.length > 0);
    assert(typeof flag.source.name === "string" && flag.source.name.length > 0);
  }
}

Deno.test("a clean, consistent run produces zero flags", () => {
  const data = auditData({
    status: "terminal",
    stageId: "done",
    journal: journal([
      { event: "started", payload: { stage: "implementation" } },
      {
        event: "artifact_recorded",
        payload: { name: "implementation-summary", version: 1 },
      },
      {
        event: "artifact_recorded",
        payload: { name: "test-summary", version: 1 },
      },
      {
        event: "artifact_recorded",
        payload: { name: "final-validation", version: 1 },
      },
      {
        event: "artifact_recorded",
        payload: { name: "draft-pull-request", version: 1 },
      },
      {
        event: "run_terminal",
        payload: { to: "done", transition: "complete" },
      },
    ]),
    artifacts: [
      {
        name: "implementation-summary",
        version: 1,
        payload: { commitSha: SHA_A },
      },
      { name: "test-summary", version: 1, payload: { commitSha: SHA_A } },
      { name: "final-validation", version: 1, payload: { commitSha: SHA_A } },
      { name: "draft-pull-request", version: 1, payload: { commitSha: SHA_A } },
    ],
  });
  const audit = buildAudit(data, "WI-500", {
    now: "2026-07-18T01:00:00.000Z",
  });
  assertEquals(audit.flags, []);
  assertEquals(audit.totals.flags, 0);
  // The reconstruction still records the terminal outcome and the SHAs.
  assertEquals(audit.runStatus, "terminal");
  assertEquals(audit.shasByArtifact["draft-pull-request"], SHA_A);
  const md = renderAuditMarkdown(audit);
  assertStringIncludes(md, "No invariant violations detected.");
});

Deno.test("a mixed-SHA lineage flags stale evidence, with the later artifact as the source", () => {
  const data = auditData({
    journal: journal([
      { event: "started", payload: { stage: "implementation" } },
      {
        event: "artifact_recorded",
        payload: { name: "implementation-summary", version: 1 },
      },
      {
        event: "artifact_recorded",
        payload: { name: "draft-pull-request", version: 1 },
      },
    ]),
    artifacts: [
      {
        name: "implementation-summary",
        version: 1,
        payload: { commitSha: SHA_A },
      },
      // A draft PR pinned to a DIFFERENT commit than the implementation.
      { name: "draft-pull-request", version: 1, payload: { commitSha: SHA_B } },
    ],
  });
  const audit = buildAudit(data, "WI-500");
  const stale = audit.flags.filter((f) => f.kind === "stale-sha");
  assert(stale.length >= 1, "expected a stale-sha flag");
  assertEquals(stale[0].source.kind, "artifact");
  assertEquals(stale[0].source.name, "draft-pull-request");
  everyFlagHasSource(audit.flags);
  // The source pointer is visible in the markdown.
  const md = renderAuditMarkdown(audit);
  assertStringIncludes(md, "source: artifact draft-pull-request");
});

Deno.test("stale-SHA flags a terminal artifact disagreeing with the current HEAD", () => {
  const data = auditData({
    journal: journal([
      { event: "started", payload: { stage: "implementation" } },
      {
        event: "artifact_recorded",
        payload: { name: "draft-pull-request", version: 1 },
      },
    ]),
    artifacts: [
      { name: "draft-pull-request", version: 1, payload: { commitSha: SHA_A } },
    ],
  });
  const audit = buildAudit(data, "WI-500", { currentHeadSha: SHA_B });
  const stale = audit.flags.filter((f) => f.kind === "stale-sha");
  assert(stale.some((f) => f.message.includes("current HEAD")));
  everyFlagHasSource(audit.flags);
});

Deno.test("an approved gate with no prior request event flags an impossible state", () => {
  const data = auditData({
    journal: journal([
      { event: "started", payload: { stage: "review" } },
      // The approval arrives with no earlier journal event mentioning the gate.
      {
        event: "approved",
        payload: { gateId: "feature-submit-approval", actor: "mat" },
      },
    ]),
  });
  const audit = buildAudit(data, "WI-500");
  const impossible = audit.flags.filter((f) => f.kind === "impossible-state");
  assert(impossible.some((f) => f.source.name === "feature-submit-approval"));
  assertEquals(impossible[0].source.kind, "approval");
  everyFlagHasSource(audit.flags);
});

Deno.test("a legitimate approval with a prior request transition does NOT flag", () => {
  const data = auditData({
    journal: journal([
      { event: "started", payload: { stage: "implementation" } },
      // A transition whose name requests the gate makes it reachable first.
      {
        event: "advanced",
        payload: {
          to: "submission-approval",
          transition: "request-submit-approval",
        },
      },
      {
        event: "approved",
        payload: { gateId: "submission-approval", actor: "mat" },
      },
    ]),
  });
  const audit = buildAudit(data, "WI-500");
  const impossible = audit.flags.filter((f) =>
    f.kind === "impossible-state" &&
    f.source.name === "submission-approval"
  );
  assertEquals(impossible, []);
});

Deno.test("final-validation vs draft-pull-request SHA mismatch flags an impossible state", () => {
  const data = auditData({
    journal: journal([
      { event: "started", payload: { stage: "final-validation" } },
      {
        event: "artifact_recorded",
        payload: { name: "final-validation", version: 1 },
      },
      {
        event: "artifact_recorded",
        payload: { name: "draft-pull-request", version: 1 },
      },
    ]),
    artifacts: [
      { name: "final-validation", version: 1, payload: { commitSha: SHA_A } },
      { name: "draft-pull-request", version: 1, payload: { commitSha: SHA_B } },
    ],
  });
  const audit = buildAudit(data, "WI-500");
  const mismatch = audit.flags.filter((f) =>
    f.kind === "impossible-state" &&
    f.message.includes("does not match draft-pull-request")
  );
  assert(mismatch.length === 1);
  assertEquals(mismatch[0].source.name, "draft-pull-request");
});

Deno.test("an unresolved critical/high finding is flagged with a source pointer", () => {
  const data = auditData({
    journal: journal([
      { event: "started", payload: { stage: "review" } },
      {
        event: "artifact_recorded",
        payload: { name: "verified-findings", version: 1 },
      },
    ]),
    artifacts: [
      {
        name: "verified-findings",
        version: 1,
        payload: {
          findings: [
            { id: "finding-1", severity: "high", resolved: false },
            { id: "finding-2", severity: "low", resolved: false },
          ],
        },
      },
    ],
  });
  const audit = buildAudit(data, "WI-500");
  const blocker = audit.flags.filter((f) => f.kind === "unresolved-blocker");
  assert(blocker.length === 1);
  assertEquals(blocker[0].source.name, "verified-findings");
  assertEquals(blocker[0].source.version, 1);
  assertStringIncludes(blocker[0].message, "finding-1");
  assertEquals(audit.totals.findingsUnresolved, 1);
});

Deno.test("terminal done with an unresolved verified blocker flags an impossible state", () => {
  const data = auditData({
    status: "terminal",
    stageId: "done",
    journal: journal([
      { event: "started", payload: { stage: "review" } },
      {
        event: "artifact_recorded",
        payload: { name: "verified-findings", version: 1 },
      },
      {
        event: "run_terminal",
        payload: { to: "done", transition: "complete" },
      },
    ]),
    artifacts: [
      {
        name: "verified-findings",
        version: 1,
        payload: {
          findings: [{
            id: "finding-1",
            severity: "critical",
            resolved: false,
          }],
        },
      },
    ],
  });
  const audit = buildAudit(data, "WI-500");
  assert(
    audit.flags.some((f) =>
      f.kind === "impossible-state" &&
      f.message.includes("terminal `done`")
    ),
  );
});

Deno.test("a retained dirty worktree surfaces with a proposed action and a resource source", () => {
  const data = auditData({
    status: "terminal",
    stageId: "cleanup-required",
    journal: journal([
      { event: "started", payload: { stage: "teardown" } },
      {
        event: "run_terminal",
        payload: { to: "cleanup-required", transition: "retain" },
      },
    ]),
  });
  const audit = buildAudit(data, "WI-500", {
    retainedWorktrees: [
      {
        identifier: "feature-WI-500",
        workItem: "WI-500",
        branch: "feature-WI-500",
        headSha: SHA_A,
        dirty: true,
        running: false,
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    ],
    now: "2026-07-18T00:00:00.000Z",
  });
  assertEquals(audit.retainedResources.length, 1);
  assertEquals(
    audit.retainedResources[0].proposedAction,
    "manual review + cleanup",
  );
  assertEquals(audit.retainedResources[0].ageDays, 3);
  const retained = audit.flags.filter((f) => f.kind === "retained-resource");
  assert(retained.length === 1);
  assertEquals(retained[0].source.kind, "resource");
  assertEquals(retained[0].source.name, "feature-WI-500");
  const md = renderAuditMarkdown(audit);
  assertStringIncludes(md, "## Retained resources");
  assertStringIncludes(md, "manual review + cleanup");
});

Deno.test("a run with no linear-correlation renders without the external section and does not crash", () => {
  const data = auditData({
    journal: journal([{
      event: "started",
      payload: { stage: "implementation" },
    }]),
  });
  const audit = buildAudit(data, "WI-500", { linearCorrelation: null });
  assertEquals(audit.linearCorrelation, undefined);
  const md = renderAuditMarkdown(audit);
  assert(
    !md.includes("External correlation"),
    "no external section when absent",
  );
});

Deno.test("a linear-correlation join renders the external-correlation section when present", () => {
  const data = auditData({
    journal: journal([{
      event: "started",
      payload: { stage: "implementation" },
    }]),
  });
  const audit = buildAudit(data, "WI-500", {
    linearCorrelation: {
      issueId: "11111111-2222-3333-4444-555555555555",
      identifier: "ENG-42",
      factoryWorkItem: "WI-500",
      branch: "feature-WI-500",
      commitSha: SHA_A,
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      correlationVersion: 3,
    },
  });
  assert(audit.linearCorrelation !== undefined);
  const md = renderAuditMarkdown(audit);
  assertStringIncludes(md, "## External correlation (Linear)");
  assertStringIncludes(md, "ENG-42");
  assertStringIncludes(md, "Correlation version:** 3");
});

Deno.test("era reconstruction opens a new era at each reset boundary", () => {
  const data = auditData({
    journal: journal([
      { event: "started", payload: { stage: "implementation" } },
      {
        event: "advanced",
        payload: { to: "testing", transition: "run-tests", cycle: 1 },
      },
      { event: "reset", stageId: "implementation" },
      {
        event: "advanced",
        payload: { to: "testing", transition: "run-tests", cycle: 1 },
      },
    ]),
  });
  const audit = buildAudit(data, "WI-500");
  // Two eras: the original run and the post-reset era.
  assertEquals(audit.totals.eras, 2);
  assertEquals(audit.eras[1].cycles[0].enteredVia, "reset");
});

// loadAuditData over a hand-implemented RunDataReader — the journal-driven load
// itself, proving no transcript/chat input is consulted (only state/journal/
// artifact/evidence records addressed by their run-name instances).
Deno.test("loadAuditData reads only state/journal/artifact records addressed by run-name instances", async () => {
  const slug = workItemSlug("WI-600");
  const reads: string[] = [];
  const store: Record<string, Record<number, Record<string, unknown>>> = {
    [`state-${slug}`]: {
      1: {
        workItem: "WI-600",
        stageId: "done",
        cycles: {},
        enteredAt: "2026-07-18T00:00:00.000Z",
        status: "terminal",
        definitionVersion: 1,
        startedAt: "2026-07-18T00:00:00.000Z",
      },
    },
    [`journal-${slug}`]: {
      1: {
        event: "artifact_recorded",
        workItem: "WI-600",
        summary: "recorded",
        payload: { name: "draft-pull-request", version: 1 },
        at: "2026-07-18T00:01:00.000Z",
      },
    },
    [`artifact-${slug}-draft-pull-request`]: {
      1: {
        name: "draft-pull-request",
        workItem: "WI-600",
        stageId: "submit",
        cycle: 1,
        payload: { commitSha: SHA_A },
        recordedAt: "2026-07-18T00:01:00.000Z",
      },
    },
  };
  const reader: RunDataReader = {
    versionsOf: (name) => {
      reads.push(`versions:${name}`);
      return Promise.resolve(Object.keys(store[name] ?? {}).map(Number));
    },
    read: (name, version) => {
      reads.push(`read:${name}`);
      const versions = store[name];
      if (versions === undefined) return Promise.resolve(null);
      const v = version ?? Math.max(...Object.keys(versions).map(Number));
      return Promise.resolve(versions[v] ?? null);
    },
  };
  const data = await loadAuditData(reader, slug);
  assertEquals(data.state?.workItem, "WI-600");
  assertEquals(
    data.artifactVersions.get("draft-pull-request")?.get(1)?.payload.commitSha,
    SHA_A,
  );
  // Only run-name-addressed instances were read — never a "transcript"/"chat".
  assert(
    reads.every((r) =>
      r.includes("state-") || r.includes("journal-") ||
      r.includes("artifact-") ||
      r.includes("evidence-")
    ),
  );
  assert(!reads.some((r) => r.includes("transcript") || r.includes("chat")));
});
