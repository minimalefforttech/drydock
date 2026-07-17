/**
 * Planner contracts (ADR 0012): first-class plans replacing the composer
 * edit/plan switch and the session-scoped plan-docs surface.
 *
 * A Plan owns an intake (brief, aspect selection, read-only context roots,
 * pre-information), at most one planning chat session, and the artifacts the
 * agent writes into its workspace `plan/` directory. After every turn - and on
 * panel open - the host collects those files into durable rows: text kinds
 * (document/diagram/prototype) inline, images into the content-addressed blob
 * store. Reviewer feedback is a PlanAnnotation anchored by the grammar below;
 * open annotations compose into one revision turn.
 *
 * Aspects are data, not code: a registry table seeded with ten defaults that
 * departments extend without schema changes. `aspectId` doubles as the
 * `plan/<aspectId>/` collection subdirectory, so it stays a plain slug string.
 */

import type { PlanAnnotationId, PlanArtifactId, PlanId, SessionId, TaskId } from "./ids.js";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type PlanStatus = "draft" | "active" | "archived";

/** The four viewer providers; `plannerKindForFile` maps collected files here. */
export type PlannerArtifactKind = "document" | "diagram" | "image" | "prototype";

/**
 * open → delegated (sent to the agent) → resolved | back to open (reopen).
 * `wont-fix` parks a note without sending it. Never auto-resolved by the host.
 */
export type PlanAnnotationStatus = "open" | "delegated" | "resolved" | "wont-fix";

export const PLAN_ANNOTATION_STATUSES: readonly PlanAnnotationStatus[] = ["open", "delegated", "resolved", "wont-fix"];

export interface PlanRecord {
  readonly planId: PlanId;
  readonly title: string;
  readonly brief: string;
  readonly aspectIds: readonly string[];
  /** Host paths mounted read-only into the planning sandbox. Display strings. */
  readonly contextRoots: readonly string[];
  readonly notes: string;
  readonly status: PlanStatus;
  readonly sessionId: SessionId | null;
  /**
   * The owning task (ADR 0006 doctrine: plans, like edits, generally belong to
   * tasks). Null = an orphan plan - allowed, but the surfaces discourage it.
   * The plan's session is auto-linked to this task on every boot.
   */
  readonly taskId: TaskId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanArtifactRecord {
  readonly artifactId: PlanArtifactId;
  readonly planId: PlanId;
  /** Path relative to the workspace `plan/` directory, forward-slashed. */
  readonly relPath: string;
  readonly kind: PlannerArtifactKind;
  /** First path segment when it names a known aspect, else "general". */
  readonly aspectId: string;
  /** Collected title (manifest → doc H1 → humanized filename). */
  readonly title: string;
  /** A user rename; wins over `title` forever once set. */
  readonly titleOverride: string | null;
  /** Starts at 1; bumps only when collected content changes. */
  readonly revision: number;
  /** Inline text for document/diagram/prototype kinds; null for images. */
  readonly content: string | null;
  /** Blob-store digest for image kinds; null for text kinds. */
  readonly blobSha256: string | null;
  readonly byteSize: number | null;
  readonly mime: string | null;
  /** Prototype kinds only: whether the sandboxed frame may run scripts. */
  readonly scriptsEnabled: boolean;
  readonly collectedAt: string;
}

export interface PlanAnnotationRecord {
  readonly annotationId: PlanAnnotationId;
  readonly planId: PlanId;
  readonly artifactId: PlanArtifactId;
  /** Anchor grammar string; see `parsePlanAnchor`. */
  readonly anchor: string;
  readonly body: string;
  readonly status: PlanAnnotationStatus;
  /** The artifact revision current when this annotation was delegated. */
  readonly delegatedRev: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanAspectRecord {
  /** Slug; doubles as the `plan/<aspectId>/` collection subdirectory. */
  readonly aspectId: string;
  readonly label: string;
  /** Briefing fragment appended when the aspect is selected. */
  readonly instructions: string;
  /** Human-readable artifact expectations, quoted in the briefing. */
  readonly expectedArtifacts: readonly string[];
  readonly sortOrder: number;
  readonly archived: boolean;
  /** Seeded rows may be edited but keep the flag for provenance. */
  readonly seeded: boolean;
}

// ---------------------------------------------------------------------------
// Collection bounds (skip, never truncate - plan-docs precedent)
// ---------------------------------------------------------------------------

export const PLANNER_MAX_FILES = 40;
export const PLANNER_MAX_TEXT_BYTES = 256 * 1024;
export const PLANNER_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Images at or under this render inline as data URIs; larger open in the editor. */
export const PLANNER_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
export const PLANNER_ASPECT_FALLBACK_ID = "general";

/** File extension → artifact kind; anything else is not a plan artifact. */
export function plannerKindForFile(name: string): PlannerArtifactKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md")) return "document";
  if (lower.endsWith(".mmd") || lower.endsWith(".mermaid")) return "diagram";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "prototype";
  if (plannerImageMime(lower) !== null) return "image";
  return null;
}

/** MIME for accepted image extensions; null for everything else. */
export function plannerImageMime(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

// ---------------------------------------------------------------------------
// Anchor grammar
// ---------------------------------------------------------------------------

/**
 * One string grammar across all providers so annotations stay a single model:
 *   block:<n>              document block index (1-based)
 *   node:<id>              rendered mermaid node group id
 *   point:<x>,<y>          normalized 0-1 coordinates
 *   region:<x>,<y>,<w>,<h> normalized 0-1 rectangle
 */
export type ParsedPlanAnchor =
  | { readonly kind: "block"; readonly index: number }
  | { readonly kind: "node"; readonly nodeId: string }
  | { readonly kind: "point"; readonly x: number; readonly y: number }
  | { readonly kind: "region"; readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const ANCHOR_NODE_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

function normalizedCoord(value: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;
  return parsed;
}

/** Parses an anchor string; null for anything outside the grammar. */
export function parsePlanAnchor(anchor: string): ParsedPlanAnchor | null {
  const separator = anchor.indexOf(":");
  if (separator <= 0) return null;
  const kind = anchor.slice(0, separator);
  const rest = anchor.slice(separator + 1);
  switch (kind) {
    case "block": {
      if (!/^\d{1,6}$/.test(rest)) return null;
      const index = Number(rest);
      return index >= 1 ? { kind: "block", index } : null;
    }
    case "node":
      return ANCHOR_NODE_ID_RE.test(rest) ? { kind: "node", nodeId: rest } : null;
    case "point": {
      const parts = rest.split(",");
      if (parts.length !== 2) return null;
      const x = normalizedCoord(parts[0] ?? "");
      const y = normalizedCoord(parts[1] ?? "");
      if (x === null || y === null) return null;
      return { kind: "point", x, y };
    }
    case "region": {
      const parts = rest.split(",");
      if (parts.length !== 4) return null;
      const x = normalizedCoord(parts[0] ?? "");
      const y = normalizedCoord(parts[1] ?? "");
      const width = normalizedCoord(parts[2] ?? "");
      const height = normalizedCoord(parts[3] ?? "");
      if (x === null || y === null || width === null || height === null) return null;
      return { kind: "region", x, y, width, height };
    }
    default:
      return null;
  }
}

/** Round-trips a parsed anchor back into its string form (3-decimal coords). */
export function formatPlanAnchor(anchor: ParsedPlanAnchor): string {
  const coord = (value: number): string => String(Math.round(value * 1000) / 1000);
  switch (anchor.kind) {
    case "block":
      return `block:${String(anchor.index)}`;
    case "node":
      return `node:${anchor.nodeId}`;
    case "point":
      return `point:${coord(anchor.x)},${coord(anchor.y)}`;
    case "region":
      return `region:${coord(anchor.x)},${coord(anchor.y)},${coord(anchor.width)},${coord(anchor.height)}`;
  }
}

/** Human form for composed instruction turns ("block 3", "node Gateway", …). */
export function describePlanAnchor(anchor: string): string {
  const parsed = parsePlanAnchor(anchor);
  if (parsed === null) return anchor;
  const pct = (value: number): string => `${String(Math.round(value * 100))}%`;
  switch (parsed.kind) {
    case "block":
      return `block ${String(parsed.index)}`;
    case "node":
      return `node ${parsed.nodeId}`;
    case "point":
      return `point ${pct(parsed.x)},${pct(parsed.y)}`;
    case "region":
      return `region ${pct(parsed.x)},${pct(parsed.y)} ${pct(parsed.width)}×${pct(parsed.height)}`;
  }
}

// ---------------------------------------------------------------------------
// Seeded aspect registry
// ---------------------------------------------------------------------------

/**
 * The ten default planning angles. Seeded once by migrations; user rows sit
 * beside them and everything is editable from the panel.
 */
export const SEEDED_PLAN_ASPECTS: readonly PlanAspectRecord[] = [
  {
    aspectId: "requirements",
    label: "Requirements & scope",
    instructions: "State the problem, the users, what is in and out of scope, and the success criteria.",
    expectedArtifacts: ["Requirements brief (document)"],
    sortOrder: 0,
    archived: false,
    seeded: true
  },
  {
    aspectId: "architecture",
    label: "System architecture",
    instructions: "Describe the components, their boundaries, the decisions taken and the alternatives rejected.",
    expectedArtifacts: ["Architecture overview (document)", "Component diagram (mermaid)"],
    sortOrder: 1,
    archived: false,
    seeded: true
  },
  {
    aspectId: "data-model",
    label: "Data model & storage",
    instructions: "Lay out the entities, relationships, migrations, and retention rules.",
    expectedArtifacts: ["Data model (document)", "Entity-relationship diagram (mermaid)"],
    sortOrder: 2,
    archived: false,
    seeded: true
  },
  {
    aspectId: "apis",
    label: "APIs & contracts",
    instructions: "Define the interfaces and message shapes, how they version, and how errors surface.",
    expectedArtifacts: ["Contract sketch (document)", "Sequence diagram (mermaid)"],
    sortOrder: 3,
    archived: false,
    seeded: true
  },
  {
    aspectId: "ui-ux",
    label: "UI / UX",
    instructions: "Inventory the screens, flows, states, and affordances. Prefer showing over telling: produce image mockups or a clickable single-file HTML prototype where it helps.",
    expectedArtifacts: ["Screen inventory (document)", "User-flow diagram (mermaid)", "Mockups (images)", "Clickable components (HTML prototype)"],
    sortOrder: 4,
    archived: false,
    seeded: true
  },
  {
    aspectId: "testing",
    label: "Testing & verification",
    instructions: "Plan the test strategy and fixtures, and state what observation proves the work is correct.",
    expectedArtifacts: ["Test plan (document)"],
    sortOrder: 5,
    archived: false,
    seeded: true
  },
  {
    aspectId: "security",
    label: "Security & permissions",
    instructions: "Identify the trust boundaries, the authorization model, and the abuse cases.",
    expectedArtifacts: ["Threat notes (document)"],
    sortOrder: 6,
    archived: false,
    seeded: true
  },
  {
    aspectId: "performance",
    label: "Performance & capacity",
    instructions: "Set the budgets, name the hot paths, and state the load expectations.",
    expectedArtifacts: ["Performance notes (document)"],
    sortOrder: 7,
    archived: false,
    seeded: true
  },
  {
    aspectId: "rollout",
    label: "Migration & rollout",
    instructions: "Sequence the delivery: flags, rollback strategy, and any migration steps.",
    expectedArtifacts: ["Rollout plan (document)"],
    sortOrder: 8,
    archived: false,
    seeded: true
  },
  {
    aspectId: "operations",
    label: "Operations & observability",
    instructions: "Cover the logs, metrics, alerts, and runbooks the feature needs in production.",
    expectedArtifacts: ["Ops notes (document)"],
    sortOrder: 9,
    archived: false,
    seeded: true
  }
];

// ---------------------------------------------------------------------------
// Display-safe projections (webview payloads)
// ---------------------------------------------------------------------------

export interface PlanSummary {
  readonly planId: string;
  readonly title: string;
  readonly brief: string;
  readonly aspectIds: readonly string[];
  readonly contextRoots: readonly string[];
  readonly notes: string;
  readonly status: PlanStatus;
  readonly sessionId: string | null;
  readonly taskId: string | null;
  /** Resolved for display when the owning task still exists. */
  readonly taskTitle?: string;
  readonly artifactCount: number;
  readonly openAnnotationCount: number;
  readonly updatedAt: string;
}

export interface PlanArtifactSummary {
  readonly artifactId: string;
  readonly relPath: string;
  readonly kind: PlannerArtifactKind;
  readonly aspectId: string;
  /** Effective display title: `titleOverride ?? title`. */
  readonly title: string;
  readonly revision: number;
  readonly scriptsEnabled: boolean;
  readonly collectedAt: string;
}

export interface PlanArtifactDetail extends PlanArtifactSummary {
  /** Inline text for document/diagram/prototype kinds. */
  readonly content?: string;
  /** data: URI for images at or under PLANNER_INLINE_IMAGE_BYTES. */
  readonly imageDataUri?: string;
  /** True when an image exists but is too large to inline. */
  readonly oversizedImage?: boolean;
}

export interface PlanAnnotationSummary {
  readonly annotationId: string;
  readonly artifactId: string;
  readonly anchor: string;
  readonly body: string;
  readonly status: PlanAnnotationStatus;
  readonly delegatedRev: number | null;
  readonly createdAt: string;
}

export interface PlanAspectSummary {
  readonly aspectId: string;
  readonly label: string;
  readonly instructions: string;
  readonly expectedArtifacts: readonly string[];
  readonly sortOrder: number;
  readonly archived: boolean;
  readonly seeded: boolean;
}

/** The full panel state for one plan; the session summary rides beside it. */
export interface PlannerStateDetail {
  readonly plan: PlanSummary;
  readonly artifacts: readonly PlanArtifactDetail[];
  readonly annotations: readonly PlanAnnotationSummary[];
  readonly aspects: readonly PlanAspectSummary[];
}

// ---------------------------------------------------------------------------
// Store interfaces (implemented by @drydock/storage-sqlite)
// ---------------------------------------------------------------------------

export interface PlanStoreUpdate {
  readonly title?: string;
  readonly brief?: string;
  readonly aspectIds?: readonly string[];
  readonly contextRoots?: readonly string[];
  readonly notes?: string;
  readonly status?: PlanStatus;
  readonly sessionId?: SessionId | null;
  readonly taskId?: TaskId | null;
  readonly updatedAt?: string;
}

export interface PlanStore {
  insertPlan(record: PlanRecord): Promise<void>;
  updatePlan(planId: PlanId, update: PlanStoreUpdate): Promise<void>;
  getPlan(planId: PlanId): Promise<PlanRecord | null>;
  /** The plan a chat session belongs to, if any (turn-completed hook lookup). */
  getPlanBySessionId(sessionId: SessionId): Promise<PlanRecord | null>;
  /** Newest-updated first. */
  listPlans(): Promise<PlanRecord[]>;
  deletePlan(planId: PlanId): Promise<void>;
}

export interface PlanArtifactStore {
  /** Insert-or-replace by artifactId; the caller owns revision numbering. */
  upsertArtifact(record: PlanArtifactRecord): Promise<void>;
  getArtifact(artifactId: PlanArtifactId): Promise<PlanArtifactRecord | null>;
  getArtifactByPath(planId: PlanId, relPath: string): Promise<PlanArtifactRecord | null>;
  /** Ordered by aspect sort context then relPath for a stable tree. */
  listArtifacts(planId: PlanId): Promise<PlanArtifactRecord[]>;
  countArtifacts(planId: PlanId): Promise<number>;
  setScriptsEnabled(artifactId: PlanArtifactId, enabled: boolean): Promise<void>;
  setTitleOverride(artifactId: PlanArtifactId, titleOverride: string | null): Promise<void>;
  deletePlanArtifacts(planId: PlanId): Promise<number>;
}

export interface PlanAnnotationUpdate {
  readonly body?: string;
  readonly status?: PlanAnnotationStatus;
  readonly delegatedRev?: number | null;
  readonly updatedAt?: string;
}

export interface PlanAnnotationStore {
  insertAnnotation(record: PlanAnnotationRecord): Promise<void>;
  updateAnnotation(annotationId: PlanAnnotationId, update: PlanAnnotationUpdate): Promise<void>;
  getAnnotation(annotationId: PlanAnnotationId): Promise<PlanAnnotationRecord | null>;
  /** Ordered by creation time. */
  listAnnotations(planId: PlanId): Promise<PlanAnnotationRecord[]>;
  countOpenAnnotations(planId: PlanId): Promise<number>;
  deleteAnnotation(annotationId: PlanAnnotationId): Promise<void>;
  deletePlanAnnotations(planId: PlanId): Promise<number>;
}

export interface PlanAspectStore {
  upsertAspect(record: PlanAspectRecord): Promise<void>;
  getAspect(aspectId: string): Promise<PlanAspectRecord | null>;
  /** sortOrder then label; archived rows included only when asked. */
  listAspects(includeArchived?: boolean): Promise<PlanAspectRecord[]>;
  setArchived(aspectId: string, archived: boolean): Promise<void>;
}
