// MIT License
//
// Copyright (c) 2026 Mat Greten
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Run-audit report for @swamp/software-factory.
 *
 * Fires after the factory's `summary` method and reconstructs one work
 * item's run deterministically from its recorded run data — state, journal,
 * and versioned artifact / evidence records — then flags invariant
 * violations (stale SHAs across the artifact lineage, impossible states,
 * unresolved critical/high blockers, and retained worktree resources). No
 * LLM is involved anywhere: the same run data always produces the same
 * audit. Every flag carries a source pointer back to the record it came
 * from.
 *
 * This module is deliberately zero-dependency and zod-free: report bundles
 * are built WITHOUT the extension import map, so nothing here may import a
 * bare npm specifier. All run-name helpers are reimplemented inline and all
 * decoded content is shape-checked with hand-written structural guards, so
 * the report is fully self-contained and bundles cleanly.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Run-name helpers (reimplemented inline; see models/_lib/run_names.ts).
// Kept zero-dependency so this report bundles without the import map.
// ---------------------------------------------------------------------------

const STATE_PREFIX = "state-";
const JOURNAL_PREFIX = "journal-";
const ARTIFACT_PREFIX = "artifact-";
const EVIDENCE_PREFIX = "evidence-";
const APPROVAL_PREFIX = "approval-";

/**
 * Turn an arbitrary workItem ref into a deterministic, data-instance-safe
 * slug. Name-safe refs pass through unchanged; anything lossy gets a stable
 * FNV-1a suffix so distinct work items can never collide after sanitization.
 */
export function workItemSlug(workItem: string): string {
  const sanitized = workItem
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48);
  if (sanitized === workItem) return workItem;
  let hash = 0x811c9dc5;
  for (let i = 0; i < workItem.length; i++) {
    hash ^= workItem.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const suffix = hash.toString(16).padStart(8, "0");
  return sanitized.length > 0 ? `${sanitized}-${suffix}` : suffix;
}

function stateInstance(slug: string): string {
  return `${STATE_PREFIX}${slug}`;
}

function journalInstance(slug: string): string {
  return `${JOURNAL_PREFIX}${slug}`;
}

function artifactInstance(slug: string, name: string): string {
  return `${ARTIFACT_PREFIX}${slug}-${name}`;
}

function evidenceInstance(slug: string, name: string): string {
  return `${EVIDENCE_PREFIX}${slug}-${name}`;
}

function approvalInstance(slug: string, gateId: string): string {
  return `${APPROVAL_PREFIX}${slug}-${gateId}`;
}

// ---------------------------------------------------------------------------
// Envelope shapes (structural, local — see models/_lib/run_data.ts).
// Defined locally so the report is self-contained.
// ---------------------------------------------------------------------------

interface RunState {
  workItem: string;
  stageId: string;
  cycles: Record<string, number>;
  enteredAt: string;
  status: "active" | "terminal";
  definitionVersion: number;
  startedAt: string;
}

interface ArtifactEnvelope {
  name: string;
  workItem: string;
  stageId: string;
  cycle: number;
  payload: Record<string, unknown>;
  subjectVersion?: number;
  recordedAt: string;
  note?: string;
}

interface EvidenceEnvelope {
  name: string;
  workItem: string;
  stageId: string;
  cycle: number;
  payload: Record<string, unknown>;
  recordedAt: string;
}

interface JournalEntry {
  event: string;
  workItem: string;
  stageId?: string;
  summary: string;
  payload?: Record<string, unknown>;
  at: string;
}

// ---------------------------------------------------------------------------
// Data access: a minimal reader over swamp's data repository, exactly the
// interface the tests hand-implement over fixture data.
// ---------------------------------------------------------------------------

/** Minimal read interface over a run's recorded data (state/journal/etc). */
export interface RunDataReader {
  /** Every stored version of a data name, ascending. */
  versionsOf(name: string): Promise<number[]>;
  /** Parsed JSON content of one version (latest when omitted). */
  read(
    name: string,
    version?: number,
  ): Promise<Record<string, unknown> | null>;
}

/** The content-fetch slice the repository-backed reader needs. */
interface ContentRepositoryLike {
  getContent(
    type: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
  listVersions?(
    type: unknown,
    modelId: string,
    dataName: string,
  ): Promise<number[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(
  repo: ContentRepositoryLike,
  modelType: unknown,
  modelId: string,
  name: string,
  version?: number,
): Promise<Record<string, unknown> | null> {
  const content = await repo.getContent(modelType, modelId, name, version);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(content));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reader backed directly by the data repository's `listVersions` /
 * `getContent`. Used in report contexts, where no query service is exposed.
 * Reimplemented inline (mirrors _lib/summary.ts repositoryRunDataReader) so
 * this report bundles zero-dependency.
 */
function repositoryRunDataReader(opts: {
  dataRepository: ContentRepositoryLike;
  modelType: unknown;
  modelId: string;
}): RunDataReader {
  return {
    versionsOf: (name) => {
      if (opts.dataRepository.listVersions === undefined) {
        return Promise.resolve([]);
      }
      return opts.dataRepository.listVersions(
        opts.modelType,
        opts.modelId,
        name,
      );
    },
    read: (name, version) =>
      readJson(
        opts.dataRepository,
        opts.modelType,
        opts.modelId,
        name,
        version,
      ),
  };
}

// ---------------------------------------------------------------------------
// Structural guards (zod-free shape checks for decoded run data).
// Tolerant by design: invalid records are skipped, never fatal.
// ---------------------------------------------------------------------------

function asRunState(value: Record<string, unknown> | null): RunState | null {
  if (value === null) return null;
  if (
    typeof value.workItem !== "string" ||
    typeof value.stageId !== "string" ||
    (value.status !== "active" && value.status !== "terminal") ||
    typeof value.definitionVersion !== "number" ||
    typeof value.enteredAt !== "string" ||
    typeof value.startedAt !== "string" ||
    !isRecord(value.cycles)
  ) {
    return null;
  }
  return value as unknown as RunState;
}

function asJournalEntry(
  value: Record<string, unknown> | null,
): JournalEntry | null {
  if (value === null) return null;
  if (
    typeof value.event !== "string" ||
    typeof value.workItem !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.at !== "string"
  ) {
    return null;
  }
  if (value.stageId !== undefined && typeof value.stageId !== "string") {
    return null;
  }
  if (value.payload !== undefined && !isRecord(value.payload)) return null;
  return value as unknown as JournalEntry;
}

function asEnvelope(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    typeof value.name !== "string" ||
    typeof value.workItem !== "string" ||
    typeof value.stageId !== "string" ||
    typeof value.cycle !== "number" ||
    typeof value.recordedAt !== "string" ||
    !isRecord(value.payload)
  ) {
    return null;
  }
  return value;
}

function asArtifactEnvelope(
  value: Record<string, unknown> | null,
): ArtifactEnvelope | null {
  const envelope = asEnvelope(value);
  if (envelope === null) return null;
  if (
    envelope.subjectVersion !== undefined &&
    typeof envelope.subjectVersion !== "number"
  ) {
    return null;
  }
  if (envelope.note !== undefined && typeof envelope.note !== "string") {
    return null;
  }
  return envelope as unknown as ArtifactEnvelope;
}

function asEvidenceEnvelope(
  value: Record<string, unknown> | null,
): EvidenceEnvelope | null {
  const envelope = asEnvelope(value);
  return envelope === null ? null : envelope as unknown as EvidenceEnvelope;
}

// ---------------------------------------------------------------------------
// Audit data loading: journal-driven, mirroring _lib/summary.ts
// loadRunHistory. The journal names every record the run ever touched, so
// loading reads state, all journal versions, then every version of each
// referenced artifact / evidence name.
// ---------------------------------------------------------------------------

/** All run data loaded for one work item: state, journal, and versioned records. */
export interface AuditData {
  slug: string;
  state: RunState | null;
  /** Journal entries oldest-first, with their version numbers. */
  journal: { version: number; entry: JournalEntry }[];
  /** True when the journal's earliest versions were garbage-collected. */
  journalTruncated: boolean;
  /** Logical artifact name → version → envelope (missing = GC'd). */
  artifactVersions: Map<string, Map<number, ArtifactEnvelope>>;
  /** Logical evidence name → version → envelope (missing = GC'd). */
  evidenceVersions: Map<string, Map<number, EvidenceEnvelope>>;
}

export async function loadAuditData(
  reader: RunDataReader,
  slug: string,
): Promise<AuditData> {
  const data: AuditData = {
    slug,
    state: null,
    journal: [],
    journalTruncated: false,
    artifactVersions: new Map(),
    evidenceVersions: new Map(),
  };

  data.state = asRunState(await reader.read(stateInstance(slug)));

  const journalName = journalInstance(slug);
  const journalVersions = await reader.versionsOf(journalName);
  data.journalTruncated = journalVersions.length > 0 && journalVersions[0] > 1;
  for (const version of journalVersions) {
    const entry = asJournalEntry(await reader.read(journalName, version));
    if (entry === null) {
      data.journalTruncated = true;
      continue;
    }
    data.journal.push({ version, entry });
  }

  // Names referenced by the surviving journal events.
  const artifactNames = new Set<string>();
  const evidenceNames = new Set<string>();
  for (const { entry } of data.journal) {
    const payload = entry.payload ?? {};
    if (
      entry.event === "artifact_recorded" && typeof payload.name === "string"
    ) {
      artifactNames.add(payload.name);
    }
    if (
      entry.event === "findings_resolved" &&
      typeof payload.artifact === "string"
    ) {
      artifactNames.add(payload.artifact);
    }
    if (
      entry.event === "evidence_recorded" && typeof payload.name === "string"
    ) {
      evidenceNames.add(payload.name);
    }
  }

  for (const name of artifactNames) {
    const instance = artifactInstance(slug, name);
    const perVersion = new Map<number, ArtifactEnvelope>();
    for (const version of await reader.versionsOf(instance)) {
      const envelope = asArtifactEnvelope(await reader.read(instance, version));
      if (envelope !== null) perVersion.set(version, envelope);
    }
    data.artifactVersions.set(name, perVersion);
  }

  for (const name of evidenceNames) {
    const instance = evidenceInstance(slug, name);
    const perVersion = new Map<number, EvidenceEnvelope>();
    for (const version of await reader.versionsOf(instance)) {
      const envelope = asEvidenceEnvelope(await reader.read(instance, version));
      if (envelope !== null) perVersion.set(version, envelope);
    }
    data.evidenceVersions.set(name, perVersion);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Report shapes.
// ---------------------------------------------------------------------------

/** A single stage visit reconstructed within an era. */
export interface StageCycle {
  stageId: string;
  cycle: number;
  enteredAt: string;
  enteredVia: string;
  terminal?: boolean;
  /** SHAs recorded during this visit, by artifact logical name. */
  shas: Record<string, string>;
  /** Findings observed during this visit (from findings-shaped artifacts). */
  findings: AuditFinding[];
}

/** One era of the run (an initial start or a post-reset re-run) and its cycles. */
export interface AuditEra {
  eraIndex: number;
  startedAt?: string;
  cycles: StageCycle[];
}

/** A single review finding observed on an artifact during a stage visit. */
export interface AuditFinding {
  id: string;
  severity: string;
  resolved: boolean;
  artifact: string;
  version: number;
  description?: string;
}

/** A recorded human approval or rejection at a gate. */
export interface AuditApproval {
  gateId: string;
  decision: "approved" | "rejected";
  actor: string;
  at: string;
}

/** Pointer back to the record that produced a flag, for traceability. */
export interface AuditFlagSource {
  kind: "artifact" | "evidence" | "journal" | "approval" | "resource";
  name: string;
  version?: number;
}

/** A detected invariant violation, with severity, message, and source. */
export interface AuditFlag {
  kind:
    | "stale-sha"
    | "impossible-state"
    | "unresolved-blocker"
    | "retained-resource";
  severity: "high" | "medium" | "low";
  message: string;
  source: AuditFlagSource;
}

/** A retained worktree resource as rendered in the audit, with a proposed action. */
export interface RetainedResourceView {
  identifier: string;
  owner?: string;
  workItem?: string;
  branch?: string;
  head?: string;
  dirty: boolean;
  running: boolean;
  ageDays?: number;
  proposedAction: string;
}

/** External issue-tracker (Linear) correlation as rendered in the audit. */
export interface LinearCorrelationView {
  issueId: string;
  identifier: string;
  factoryWorkItem: string;
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  correlationVersion: number;
}

/** The full reconstructed audit for a run: eras, approvals, SHAs, flags, and totals. */
export interface AuditReport {
  workItem: string;
  runStatus: "active" | "terminal" | "unknown";
  currentStageId?: string;
  eras: AuditEra[];
  approvals: AuditApproval[];
  /** Artifact logical name → commitSha the run recorded (latest version). */
  shasByArtifact: Record<string, string>;
  flags: AuditFlag[];
  retainedResources: RetainedResourceView[];
  linearCorrelation?: LinearCorrelationView;
  journalTruncated: boolean;
  totals: {
    eras: number;
    approvals: number;
    rejections: number;
    findingsTotal: number;
    findingsUnresolved: number;
    flags: number;
  };
}

// ---------------------------------------------------------------------------
// buildAudit inputs (joins are supplied via options so buildAudit stays pure
// and unit-testable over hand-built fixtures).
// ---------------------------------------------------------------------------

/** An optional retained-worktree join input supplied to buildAudit. */
export interface RetainedWorktree {
  identifier: string;
  workItem?: string;
  branch?: string;
  headSha?: string;
  dirty?: boolean;
  running?: boolean;
  createdAt?: string;
}

/** An optional external issue-tracker correlation join input supplied to buildAudit. */
export interface LinearCorrelation {
  issueId: string;
  identifier: string;
  factoryWorkItem: string;
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  correlationVersion: number;
}

/** Optional pluggable joins and clock for buildAudit; all default to empty/none. */
export interface BuildAuditOptions {
  retainedWorktrees?: RetainedWorktree[];
  linearCorrelation?: LinearCorrelation | null;
  currentHeadSha?: string;
  /** "now" for age computation; defaults to new Date().toISOString(). */
  now?: string;
}

// ---------------------------------------------------------------------------
// Reconstruction + flagging helpers.
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

interface RawFinding {
  id?: unknown;
  severity?: unknown;
  resolved?: unknown;
  description?: unknown;
}

/**
 * A payload is findings-shaped when `payload.findings` is an array of objects
 * carrying severity / resolved fields.
 */
function findingsOf(
  payload: Record<string, unknown> | undefined,
): RawFinding[] | undefined {
  if (payload === undefined) return undefined;
  const findings = payload.findings;
  if (!Array.isArray(findings)) return undefined;
  if (
    !findings.every((f) =>
      f !== null && typeof f === "object" && !Array.isArray(f)
    )
  ) {
    return undefined;
  }
  return findings as RawFinding[];
}

/** Latest (highest) version envelope of an artifact, or undefined. */
function latestArtifact(
  perVersion: Map<number, ArtifactEnvelope> | undefined,
): { version: number; envelope: ArtifactEnvelope } | undefined {
  if (perVersion === undefined || perVersion.size === 0) return undefined;
  const versions = [...perVersion.keys()].sort((a, b) => a - b);
  const version = versions[versions.length - 1];
  const envelope = perVersion.get(version);
  return envelope === undefined ? undefined : { version, envelope };
}

/** Read a recorded commitSha (or expectedHeadSha) from a payload. */
function shaOf(payload: Record<string, unknown>): string | undefined {
  return str(payload.commitSha) ?? str(payload.expectedHeadSha);
}

const HIGH_SEVERITIES = new Set(["critical", "high"]);

function isBlocking(finding: RawFinding): boolean {
  const severity = typeof finding.severity === "string"
    ? finding.severity.toLowerCase()
    : "";
  return HIGH_SEVERITIES.has(severity) && finding.resolved !== true;
}

// Artifact lineage for stale-SHA comparison, earliest → latest. Alternates
// (patched / final variants) are accepted in place of the base name when
// present.
const SHA_LINEAGE: string[] = [
  "implementation-summary",
  "patched-implementation-summary",
  "test-summary",
  "final-test-summary",
  "browser-summary",
  "final-browser-summary",
  "final-validation",
  "draft-pull-request",
];

// ---------------------------------------------------------------------------
// buildAudit: the pure reconstruction + flagging core.
// ---------------------------------------------------------------------------

/**
 * The pure reconstruction + flagging core: replays the journal into eras and
 * stage cycles, then raises stale-SHA, impossible-state, unresolved-blocker,
 * and retained-resource flags. Optional joins are supplied via options.
 */
export function buildAudit(
  auditData: AuditData,
  workItem: string,
  options: BuildAuditOptions = {},
): AuditReport {
  const now = options.now ?? new Date().toISOString();
  const state = auditData.state;
  const runStatus: "active" | "terminal" | "unknown" = state?.status ??
    "unknown";
  const currentStageId = state?.stageId;

  // --- Era + stage-cycle reconstruction -----------------------------------
  const eras: AuditEra[] = [];
  let currentEra: AuditEra | null = null;
  let currentCycle: StageCycle | null = null;

  const openEra = (startedAt?: string): AuditEra => {
    const era: AuditEra = { eraIndex: eras.length, startedAt, cycles: [] };
    eras.push(era);
    currentEra = era;
    currentCycle = null;
    return era;
  };

  const ensureEra = (startedAt?: string): AuditEra => {
    return currentEra ?? openEra(startedAt);
  };

  const openCycle = (visit: StageCycle): StageCycle => {
    const era = ensureEra(visit.enteredAt);
    era.cycles.push(visit);
    currentCycle = visit;
    return visit;
  };

  const ensureCycle = (entry: JournalEntry): StageCycle => {
    if (currentCycle === null) {
      return openCycle({
        stageId: entry.stageId ?? "(unknown)",
        cycle: 1,
        enteredAt: entry.at,
        enteredVia: "(unknown)",
        shas: {},
        findings: [],
      });
    }
    return currentCycle;
  };

  const approvals: AuditApproval[] = [];
  const flags: AuditFlag[] = [];
  // gateId → first journal `at` mentioning that gate (any event), for the
  // impossible-state "approved with no prior request" check.
  const gateFirstSeen = new Map<string, string>();

  const mentionsGate = (entry: JournalEntry): string | undefined => {
    const payload = entry.payload ?? {};
    const gateId = str(payload.gateId);
    return gateId;
  };

  for (const { entry } of auditData.journal) {
    const payload = entry.payload ?? {};

    // Track the earliest journal appearance of any gate id, from any event
    // other than the approval/rejection itself.
    if (entry.event !== "approved" && entry.event !== "rejected") {
      const gateId = mentionsGate(entry);
      if (gateId !== undefined && !gateFirstSeen.has(gateId)) {
        gateFirstSeen.set(gateId, entry.at);
      }
      // A journal `advanced` transition whose payload.transition contains
      // "request" reads as the gate becoming reachable.
      const transition = str(payload.transition);
      const to = str(payload.to);
      if (
        transition !== undefined && transition.toLowerCase().includes("request")
      ) {
        if (to !== undefined && !gateFirstSeen.has(to)) {
          gateFirstSeen.set(to, entry.at);
        }
      }
    }

    switch (entry.event) {
      case "started": {
        openEra(str(payload.startedAt) ?? entry.at);
        openCycle({
          stageId: str(payload.stage) ?? entry.stageId ?? "(unknown)",
          cycle: 1,
          enteredAt: entry.at,
          enteredVia: "start",
          shas: {},
          findings: [],
        });
        break;
      }

      case "reset": {
        // A new era begins at each journal reset event.
        openEra(entry.at);
        openCycle({
          stageId: entry.stageId ?? "(unknown)",
          cycle: 1,
          enteredAt: entry.at,
          enteredVia: "reset",
          shas: {},
          findings: [],
        });
        break;
      }

      case "advanced":
      case "run_terminal": {
        const to = str(payload.to) ?? entry.stageId ?? "(unknown)";
        const transition = str(payload.transition) ?? "(unknown)";
        const terminal = entry.event === "run_terminal";
        openCycle({
          stageId: to,
          cycle: num(payload.cycle) ?? 1,
          enteredAt: entry.at,
          enteredVia: transition,
          terminal,
          shas: {},
          findings: [],
        });
        break;
      }

      case "artifact_recorded": {
        const visit = ensureCycle(entry);
        const name = str(payload.name) ?? "(unknown)";
        const version = num(payload.version);
        const perVersion = auditData.artifactVersions.get(name);
        const envelope = version !== undefined
          ? perVersion?.get(version)
          : latestArtifact(perVersion)?.envelope;
        if (envelope !== undefined) {
          const sha = shaOf(envelope.payload);
          if (sha !== undefined) visit.shas[name] = sha;
          const findings = findingsOf(envelope.payload);
          if (findings !== undefined) {
            for (const f of findings) {
              visit.findings.push({
                id: str(f.id) ?? "(finding)",
                severity: typeof f.severity === "string" ? f.severity : "",
                resolved: f.resolved === true,
                artifact: name,
                version: version ?? latestArtifact(perVersion)?.version ?? 0,
                description: str(f.description),
              });
            }
          }
        }
        break;
      }

      case "evidence_recorded": {
        ensureCycle(entry);
        break;
      }

      case "findings_resolved": {
        ensureCycle(entry);
        break;
      }

      case "approved":
      case "rejected": {
        ensureCycle(entry);
        const gateId = str(payload.gateId) ?? "(unknown)";
        approvals.push({
          gateId,
          decision: entry.event,
          actor: str(payload.actor) ?? "(unknown)",
          at: entry.at,
        });
        break;
      }

      default: {
        ensureCycle(entry);
      }
    }
  }

  // --- shasByArtifact: latest recorded SHA per artifact name ---------------
  const shasByArtifact: Record<string, string> = {};
  for (const [name, perVersion] of auditData.artifactVersions) {
    const latest = latestArtifact(perVersion);
    if (latest === undefined) continue;
    const sha = shaOf(latest.envelope.payload);
    if (sha !== undefined) shasByArtifact[name] = sha;
  }

  // --- Flag A: stale-SHA across the artifact lineage -----------------------
  // Walk the lineage in order; flag any disagreement between an earlier and a
  // later present artifact's SHA. Source = the LATER artifact.
  const lineagePresent: { name: string; sha: string; version: number }[] = [];
  for (const name of SHA_LINEAGE) {
    const latest = latestArtifact(auditData.artifactVersions.get(name));
    if (latest === undefined) continue;
    const sha = shaOf(latest.envelope.payload);
    if (sha === undefined) continue;
    lineagePresent.push({ name, sha, version: latest.version });
  }
  for (let i = 1; i < lineagePresent.length; i++) {
    const later = lineagePresent[i];
    for (let j = 0; j < i; j++) {
      const earlier = lineagePresent[j];
      if (earlier.sha !== later.sha) {
        flags.push({
          kind: "stale-sha",
          severity: "high",
          message:
            `Recorded commit SHA drifted across the artifact lineage: ${earlier.name} (${earlier.sha}) disagrees with ${later.name} (${later.sha}).`,
          source: {
            kind: "artifact",
            name: later.name,
            version: later.version,
          },
        });
        break;
      }
    }
  }

  // stale-SHA vs the supplied current HEAD, for terminal PR / final-validation.
  if (options.currentHeadSha !== undefined) {
    for (const name of ["draft-pull-request", "final-validation"]) {
      const latest = latestArtifact(auditData.artifactVersions.get(name));
      if (latest === undefined) continue;
      const sha = shaOf(latest.envelope.payload);
      if (sha !== undefined && sha !== options.currentHeadSha) {
        flags.push({
          kind: "stale-sha",
          severity: "high",
          message:
            `${name} recorded commit ${sha} but the current HEAD is ${options.currentHeadSha}.`,
          source: { kind: "artifact", name, version: latest.version },
        });
      }
    }
  }

  // --- Flag B: impossible-state --------------------------------------------
  // B1: an approval for a gateId with no journal event mentioning that gate
  // before the approval. Source = the approval.
  for (const approval of approvals) {
    if (approval.decision !== "approved") continue;
    const firstSeen = gateFirstSeen.get(approval.gateId);
    if (firstSeen === undefined || firstSeen > approval.at) {
      flags.push({
        kind: "impossible-state",
        severity: "high",
        message:
          `Gate ${approval.gateId} was approved with no prior request event in the journal.`,
        source: { kind: "approval", name: approval.gateId },
      });
    }
  }

  // B2: final-validation.commitSha != draft-pull-request.commitSha (when both
  // present). Source = draft-pull-request artifact.
  {
    const finalValidation = latestArtifact(
      auditData.artifactVersions.get("final-validation"),
    );
    const draftPr = latestArtifact(
      auditData.artifactVersions.get("draft-pull-request"),
    );
    if (finalValidation !== undefined && draftPr !== undefined) {
      const fvSha = shaOf(finalValidation.envelope.payload);
      const prSha = shaOf(draftPr.envelope.payload);
      if (fvSha !== undefined && prSha !== undefined && fvSha !== prSha) {
        flags.push({
          kind: "impossible-state",
          severity: "high",
          message:
            `final-validation commit (${fvSha}) does not match draft-pull-request commit (${prSha}).`,
          source: {
            kind: "artifact",
            name: "draft-pull-request",
            version: draftPr.version,
          },
        });
      }
    }
  }

  // --- Flag C: unresolved-blocker over findings-shaped artifacts -----------
  // Latest version of any findings-shaped artifact; critical/high & not
  // resolved. Source = that artifact + version.
  let findingsTotal = 0;
  let findingsUnresolved = 0;
  const unresolvedBlockerArtifacts = new Map<
    string,
    { version: number; ids: string[] }
  >();
  for (const [name, perVersion] of auditData.artifactVersions) {
    const latest = latestArtifact(perVersion);
    if (latest === undefined) continue;
    const findings = findingsOf(latest.envelope.payload);
    if (findings === undefined) continue;
    for (const f of findings) {
      findingsTotal += 1;
      if (isBlocking(f)) {
        findingsUnresolved += 1;
        const id = str(f.id) ?? "(finding)";
        const bucket = unresolvedBlockerArtifacts.get(name) ??
          { version: latest.version, ids: [] };
        bucket.ids.push(id);
        unresolvedBlockerArtifacts.set(name, bucket);
      }
    }
  }
  for (const [name, bucket] of unresolvedBlockerArtifacts) {
    flags.push({
      kind: "unresolved-blocker",
      severity: "high",
      message: `${name} carries unresolved critical/high finding(s): ${
        bucket.ids.join(", ")
      }.`,
      source: { kind: "artifact", name, version: bucket.version },
    });
  }

  // B3: terminal `done` with any unresolved verified critical/high finding.
  // Source = the verified-findings artifact.
  if (runStatus === "terminal" && currentStageId === "done") {
    const verified = latestArtifact(
      auditData.artifactVersions.get("verified-findings"),
    );
    if (verified !== undefined) {
      const findings = findingsOf(verified.envelope.payload);
      if (findings !== undefined && findings.some(isBlocking)) {
        flags.push({
          kind: "impossible-state",
          severity: "high",
          message:
            "Run reached terminal `done` with unresolved verified critical/high findings.",
          source: {
            kind: "artifact",
            name: "verified-findings",
            version: verified.version,
          },
        });
      }
    }
  }

  // --- Flag D: retained-resource -------------------------------------------
  const retainedResources: RetainedResourceView[] = [];
  for (const worktree of options.retainedWorktrees ?? []) {
    const dirty = worktree.dirty === true;
    const running = worktree.running === true;
    const ageDays = worktree.createdAt !== undefined
      ? ageInDays(worktree.createdAt, now)
      : undefined;
    const notActive = runStatus !== "active";
    const proposedAction = dirty
      ? "manual review + cleanup"
      : "safe to remove after verifying branch/HEAD";

    retainedResources.push({
      identifier: worktree.identifier,
      workItem: worktree.workItem,
      branch: worktree.branch,
      head: worktree.headSha,
      dirty,
      running,
      ageDays,
      proposedAction,
    });

    if (notActive || dirty) {
      flags.push({
        kind: "retained-resource",
        severity: dirty ? "medium" : "low",
        message: dirty
          ? `Worktree ${worktree.identifier} is dirty and retained; proposed action: ${proposedAction}.`
          : `Worktree ${worktree.identifier} is retained but its run is not active; proposed action: ${proposedAction}.`,
        source: { kind: "resource", name: worktree.identifier },
      });
    }
  }

  // --- Linear correlation view (only when supplied) ------------------------
  let linearCorrelation: LinearCorrelationView | undefined;
  if (
    options.linearCorrelation !== undefined &&
    options.linearCorrelation !== null
  ) {
    const lc = options.linearCorrelation;
    linearCorrelation = {
      issueId: lc.issueId,
      identifier: lc.identifier,
      factoryWorkItem: lc.factoryWorkItem,
      branch: lc.branch,
      commitSha: lc.commitSha,
      prNumber: lc.prNumber,
      prUrl: lc.prUrl,
      correlationVersion: lc.correlationVersion,
    };
  }

  const report: AuditReport = {
    workItem,
    runStatus,
    currentStageId,
    eras,
    approvals,
    shasByArtifact,
    flags,
    retainedResources,
    journalTruncated: auditData.journalTruncated,
    totals: {
      eras: eras.length,
      approvals: approvals.filter((a) => a.decision === "approved").length,
      rejections: approvals.filter((a) => a.decision === "rejected").length,
      findingsTotal,
      findingsUnresolved,
      flags: flags.length,
    },
  };
  if (linearCorrelation !== undefined) {
    report.linearCorrelation = linearCorrelation;
  }
  return report;
}

/** Whole days between two ISO timestamps (from → to), or undefined. */
function ageInDays(fromIso: string, toIso: string): number | undefined {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  const days = Math.floor((to - from) / 86_400_000);
  return days < 0 ? 0 : days;
}

// ---------------------------------------------------------------------------
// Markdown rendering — deterministic; same AuditReport always renders the
// same output.
// ---------------------------------------------------------------------------

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
}

function sourcePointer(source: AuditFlagSource): string {
  const version = source.version !== undefined ? ` v${source.version}` : "";
  return `source: ${source.kind} ${source.name}${version}`;
}

/** Render an AuditReport to deterministic markdown (same report → same output). */
export function renderAuditMarkdown(audit: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Run Audit: ${audit.workItem}`);
  lines.push("");

  // Run status + current stage.
  const statusBits: string[] = [`**Run status:** ${audit.runStatus}`];
  if (audit.currentStageId !== undefined) {
    statusBits.push(`**Current stage:** \`${audit.currentStageId}\``);
  }
  lines.push(statusBits.join(" · "), "");

  const t = audit.totals;
  lines.push(
    [
      `${t.eras} era${t.eras === 1 ? "" : "s"}`,
      `${t.approvals} approvals`,
      ...(t.rejections > 0 ? [`${t.rejections} rejections`] : []),
      `${t.findingsTotal} findings (${t.findingsUnresolved} unresolved)`,
      `${t.flags} flag${t.flags === 1 ? "" : "s"}`,
    ].join(" · "),
    "",
  );

  if (audit.journalTruncated) {
    lines.push(
      "_The earliest journal entries were garbage-collected; this audit" +
        " begins at the oldest surviving event._",
      "",
    );
  }

  // Per-era cycle reconstruction.
  lines.push("## Cycle reconstruction", "");
  if (audit.eras.length === 0) {
    lines.push("_No stage visits reconstructed._", "");
  }
  for (const era of audit.eras) {
    lines.push(
      `### Era ${era.eraIndex}${
        era.startedAt !== undefined ? ` — started ${era.startedAt}` : ""
      }`,
      "",
    );
    if (era.cycles.length === 0) {
      lines.push("_No stage visits in this era._", "");
    }
    era.cycles.forEach((visit, index) => {
      lines.push(
        `${
          index + 1
        }. **${visit.stageId}** (cycle ${visit.cycle}) — entered ${visit.enteredAt} via ${visit.enteredVia}${
          visit.terminal === true ? " (terminal)" : ""
        }`,
      );
      const shaNames = Object.keys(visit.shas).sort();
      for (const name of shaNames) {
        lines.push(`   - SHA ${name}: \`${visit.shas[name]}\``);
      }
      for (const finding of visit.findings) {
        lines.push(
          `   - finding ${finding.id} (${finding.severity}${
            finding.resolved ? ", resolved" : ", open"
          }) in ${finding.artifact} v${finding.version}`,
        );
      }
    });
    lines.push("");
  }

  // Approvals.
  if (audit.approvals.length > 0) {
    lines.push("## Approvals", "");
    for (const approval of audit.approvals) {
      const icon = approval.decision === "approved" ? "✅" : "❌";
      lines.push(
        `- ${icon} ${approval.gateId} — **${approval.decision}** by ${approval.actor} at ${approval.at}`,
      );
    }
    lines.push("");
  }

  // SHAs table.
  lines.push("## Recorded SHAs", "");
  const shaNames = Object.keys(audit.shasByArtifact).sort();
  if (shaNames.length === 0) {
    lines.push("_No commit SHAs recorded._", "");
  } else {
    lines.push("| Artifact | commitSha |", "| --- | --- |");
    for (const name of shaNames) {
      lines.push(
        `| ${escapeCell(name)} | \`${
          escapeCell(audit.shasByArtifact[name])
        }\` |`,
      );
    }
    lines.push("");
  }

  // Flags — each with kind, severity, message and a VISIBLE source pointer.
  lines.push("## Flags", "");
  if (audit.flags.length === 0) {
    lines.push("No invariant violations detected.", "");
  } else {
    for (const flag of audit.flags) {
      lines.push(
        `- **[${flag.kind}]** (${flag.severity}) ${flag.message} _(${
          sourcePointer(flag.source)
        })_`,
      );
    }
    lines.push("");
  }

  // Retained resources (only if any).
  if (audit.retainedResources.length > 0) {
    lines.push("## Retained resources", "");
    lines.push(
      "| Worktree | Owner | Work item | Branch | HEAD | Dirty | Running | Age (days) | Proposed action |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const r of audit.retainedResources) {
      lines.push(
        "| " +
          [
            escapeCell(r.identifier),
            escapeCell(r.owner ?? ""),
            escapeCell(r.workItem ?? ""),
            escapeCell(r.branch ?? ""),
            escapeCell(r.head ?? ""),
            r.dirty ? "yes" : "no",
            r.running ? "yes" : "no",
            r.ageDays !== undefined ? String(r.ageDays) : "",
            escapeCell(r.proposedAction),
          ].join(" | ") +
          " |",
      );
    }
    lines.push("");
  }

  // External correlation (only when linearCorrelation present).
  if (audit.linearCorrelation !== undefined) {
    const lc = audit.linearCorrelation;
    lines.push("## External correlation (Linear)", "");
    lines.push(`- **Issue:** ${lc.identifier} (${lc.issueId})`);
    lines.push(`- **Factory work item:** ${lc.factoryWorkItem}`);
    if (lc.branch !== undefined) lines.push(`- **Branch:** \`${lc.branch}\``);
    if (lc.commitSha !== undefined) {
      lines.push(`- **Commit:** \`${lc.commitSha}\``);
    }
    if (lc.prNumber !== undefined || lc.prUrl !== undefined) {
      const prLabel = lc.prNumber !== undefined ? `#${lc.prNumber}` : "PR";
      lines.push(
        `- **PR:** ${
          lc.prUrl !== undefined ? `[${prLabel}](${lc.prUrl})` : prLabel
        }`,
      );
    }
    lines.push(`- **Correlation version:** ${lc.correlationVersion}`);
    lines.push("");
  }

  return lines.join("\n").replaceAll(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Report contract.
// ---------------------------------------------------------------------------

/** Structural slice of swamp's MethodReportContext. */
interface ReportContext {
  scope: string;
  modelType: unknown;
  modelId: string;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  methodArgs: Record<string, unknown>;
  definition?: { name?: string };
  dataRepository: {
    getContent(
      type: unknown,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<Uint8Array | null>;
    listVersions?(
      type: unknown,
      modelId: string,
      dataName: string,
    ): Promise<number[]>;
  };
}

const FACTORY_TYPE = "@swamp/software-factory";

/** The report contract swamp invokes: method-scoped, gated to the factory type. */
export const report = {
  name: "@mgreten/software-factory-run-audit",
  description:
    "Deterministic run reconstruction and invariant-violation audit of a factory work item — stale SHAs, impossible states, unresolved blockers, and retained resources — rendered statically from recorded run data",
  scope: "method",
  labels: ["software-factory"],
  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (
      String(context.modelType) !== FACTORY_TYPE ||
      context.methodName !== "summary"
    ) {
      return { markdown: "", json: {} };
    }
    const workItem = context.methodArgs.workItem;
    if (typeof workItem !== "string" || workItem.length === 0) {
      return { markdown: "", json: {} };
    }
    // Reports also run on the failure path; persist the reason rather than an
    // empty placeholder version.
    if (context.executionStatus !== "succeeded") {
      const error = context.errorMessage ?? "unknown error";
      return {
        markdown: `# Run Audit: ${workItem}\n\n_Audit failed: ${error}_\n`,
        json: { workItem, error },
      };
    }

    // Report contexts expose the data repository but no query service;
    // listVersions is the version-accurate interface there. Reimplemented
    // inline so this report bundles zero-dependency.
    const reader = repositoryRunDataReader({
      dataRepository: context.dataRepository,
      modelType: context.modelType,
      modelId: context.modelId,
    });
    const auditData = await loadAuditData(reader, workItemSlug(workItem));

    // The retained-worktree join and the external issue-tracker (Linear)
    // correlation join are optional, pluggable cross-model reads that the
    // report context cannot perform on its own. A caller or test harness that
    // has that data supplies it to buildAudit directly (see BuildAuditOptions);
    // here we pass the pure-empty joins so the audit never crashes when they
    // are absent, and the report degrades gracefully to the run-data-only view.
    const audit = buildAudit(auditData, workItem, {
      retainedWorktrees: [],
      linearCorrelation: null,
    });

    return {
      markdown: renderAuditMarkdown(audit),
      json: audit as unknown as Record<string, unknown>,
    };
  },
};

// approvalInstance is part of the run-name helper family reimplemented here
// for self-containment; the audit reads approvals from the journal spine, but
// the helper is exported so callers/tests can address approval records
// directly and it stays in lockstep with the rest of the naming scheme.
export { approvalInstance };
