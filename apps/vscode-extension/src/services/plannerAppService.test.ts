/**
 * PlannerAppService tests: intake → session boot → collection → hydration →
 * instruction composition, plus the aspect registry rules. Real SQLite stores
 * and a real blob store over temp dirs; session control is a recording fake.
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContentAddressedBlobStore } from "@drydock/artifacts";
import { asId, type ChatModelSelection, type JsonObject, type SessionId } from "@drydock/contracts";
import { ProductEventBus, RandomIdGenerator, type Clock, type Logger, type ProductBusEvent } from "@drydock/core";
import {
  applyMigrations,
  SqliteConnection,
  SqlitePlanAnnotationStore,
  SqlitePlanArtifactStore,
  SqlitePlanAspectStore,
  SqlitePlanStore
} from "@drydock/storage-sqlite";
import type { ChatWorkspaceContext } from "./isolatedRunService.js";
import { PlannerAppService, type PlannerSessionsPort } from "./plannerAppService.js";

class NullLogger implements Logger {
  info(_message: string, _metadata?: JsonObject): void {}
  warn(_message: string, _metadata?: JsonObject): void {}
  error(_message: string, _metadata?: JsonObject): void {}
}

class TickingClock implements Clock {
  private tick = 0;
  now(): Date {
    return new Date(this.isoNow());
  }
  isoNow(): string {
    this.tick += 1;
    return `2026-07-10T00:00:${String(this.tick).padStart(2, "0")}.000Z`;
  }
}

class FakeSessions implements PlannerSessionsPort {
  readonly prompts: string[] = [];
  readonly startedWorkspaces: (ChatWorkspaceContext | undefined)[] = [];
  reclaims = 0;
  private live = new Set<string>();
  private nextSession = 0;

  async startChatSession(
    _model?: ChatModelSelection,
    _title?: string,
    workspace?: ChatWorkspaceContext
  ): Promise<{ readonly session: { readonly sessionId: SessionId } }> {
    this.nextSession += 1;
    const sessionId = asId<"SessionId">(`session-${String(this.nextSession)}`);
    this.live.add(sessionId);
    this.startedWorkspaces.push(workspace);
    return { session: { sessionId } };
  }

  async reclaimChatSession(sessionId: string): Promise<unknown> {
    this.reclaims += 1;
    this.live.add(sessionId);
    return {};
  }

  async sendChatTurn(_sessionId: string, prompt: string): Promise<unknown> {
    this.prompts.push(prompt);
    return {};
  }

  isChatSessionLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  hasActiveChatTurn(_sessionId: string): boolean {
    return false;
  }

  kill(sessionId: string): void {
    this.live.delete(sessionId);
  }
}

interface Harness {
  readonly service: PlannerAppService;
  readonly sessions: FakeSessions;
  readonly busEvents: ProductBusEvent[];
  readonly setWorkspace: (dir: string | null) => void;
  readonly dir: string;
  readonly connection: SqliteConnection;
}

async function makeHarness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-planner-"));
  const connection = new SqliteConnection(path.join(dir, "state.sqlite"));
  applyMigrations(connection);
  const sessions = new FakeSessions();
  const busEvents: ProductBusEvent[] = [];
  const bus = new ProductEventBus();
  bus.subscribe((event) => busEvents.push(event));
  let workspaceDir: string | null = null;
  const service = new PlannerAppService({
    logger: new NullLogger(),
    clock: new TickingClock(),
    ids: new RandomIdGenerator(),
    plans: new SqlitePlanStore(connection),
    artifacts: new SqlitePlanArtifactStore(connection),
    annotations: new SqlitePlanAnnotationStore(connection),
    aspects: new SqlitePlanAspectStore(connection),
    blobs: new ContentAddressedBlobStore(path.join(dir, "blobs")),
    sessions,
    chat: { getSessionWorkspacePath: () => workspaceDir, getSession: async () => null },
    bus
  });
  return {
    service,
    sessions,
    busEvents,
    setWorkspace: (value) => { workspaceDir = value; },
    dir,
    connection
  };
}

async function seedPlanFiles(workspace: string): Promise<void> {
  const plan = path.join(workspace, "plan");
  await mkdir(path.join(plan, "architecture"), { recursive: true });
  await mkdir(path.join(plan, "ui-ux"), { recursive: true });
  await mkdir(path.join(plan, "scratch"), { recursive: true });
  await writeFile(path.join(plan, "architecture", "overview.md"), "# Architecture Overview\n\nThe shape of it.\n", "utf8");
  await writeFile(path.join(plan, "architecture", "components.mmd"), "flowchart LR\n  a --> b\n", "utf8");
  await writeFile(path.join(plan, "ui-ux", "login-prototype.html"), "<main><button>Sign in</button></main>", "utf8");
  await writeFile(path.join(plan, "ui-ux", "mock.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  await writeFile(path.join(plan, "scratch", "notes.md"), "no heading here\n", "utf8");
  await writeFile(path.join(plan, "manifest.json"), JSON.stringify({ "architecture/components.mmd": "Component Diagram" }), "utf8");
  await writeFile(path.join(plan, "ignored.txt"), "not a plan kind", "utf8");
}

test("create → start boots a plan-mode session, hydrates, and sends the briefing", async () => {
  const harness = await makeHarness();
  try {
    const plan = await harness.service.createPlan({
      brief: "Replace the legacy cookie stack with OIDC.",
      aspectIds: ["architecture", "testing"],
      contextRoots: ["C:\\repos\\app\\src"],
      notes: "Server-side sessions only."
    });
    assert.equal(plan.status, "draft");
    assert.equal(plan.title, "Replace the legacy cookie stack with OIDC.");

    harness.setWorkspace(path.join(harness.dir, "ws-1"));
    await mkdir(path.join(harness.dir, "ws-1"), { recursive: true });
    const sessionId = await harness.service.startPlanSession(plan.planId);
    assert.equal(sessionId, "session-1");

    const stored = await harness.service.getPlan(plan.planId);
    assert.ok(stored);
    assert.equal(stored.status, "active");
    assert.equal(stored.sessionId, "session-1");

    // Plan mode, explicit context roots — the container mount is the boundary.
    const workspace = harness.sessions.startedWorkspaces[0];
    assert.ok(workspace);
    assert.equal(workspace.mode, "plan");
    assert.deepEqual(workspace.roots, ["C:\\repos\\app\\src"]);

    // The initial briefing turn fired (detached) because the plan is empty.
    assert.equal(harness.sessions.prompts.length, 1);
    const briefing = harness.sessions.prompts[0] ?? "";
    assert.ok(briefing.includes("Replace the legacy cookie stack with OIDC."));
    assert.ok(briefing.includes("plan/architecture/"));
    assert.ok(briefing.includes("Server-side sessions only."));
    assert.ok(briefing.includes("Testing & verification"));
  } finally {
    harness.connection.close();
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("collection maps kinds, titles, aspects; bumps revisions only on change", async () => {
  const harness = await makeHarness();
  try {
    const plan = await harness.service.createPlan({ brief: "b", aspectIds: ["architecture", "ui-ux"], contextRoots: [] });
    const workspace = path.join(harness.dir, "ws");
    await mkdir(workspace, { recursive: true });
    harness.setWorkspace(workspace);
    await harness.service.startPlanSession(plan.planId);
    await seedPlanFiles(workspace);

    const collected = await harness.service.collectPlanArtifacts(plan.planId);
    const byPath = new Map(collected.map((artifact) => [artifact.relPath, artifact]));
    assert.equal(collected.length, 5);

    const doc = byPath.get("architecture/overview.md");
    assert.ok(doc);
    assert.equal(doc.kind, "document");
    assert.equal(doc.title, "Architecture Overview");
    assert.equal(doc.aspectId, "architecture");
    assert.equal(doc.revision, 1);

    const diagram = byPath.get("architecture/components.mmd");
    assert.ok(diagram);
    assert.equal(diagram.kind, "diagram");
    // Manifest title wins over the humanized filename.
    assert.equal(diagram.title, "Component Diagram");

    const prototype = byPath.get("ui-ux/login-prototype.html");
    assert.ok(prototype);
    assert.equal(prototype.kind, "prototype");
    assert.equal(prototype.title, "Login prototype");
    assert.equal(prototype.scriptsEnabled, false);

    const image = byPath.get("ui-ux/mock.png");
    assert.ok(image);
    assert.equal(image.kind, "image");
    assert.ok(image.blobSha256);
    assert.equal(image.content, null);
    assert.equal(image.mime, "image/png");

    // Unknown subdirectory groups under "general".
    const scratch = byPath.get("scratch/notes.md");
    assert.ok(scratch);
    assert.equal(scratch.aspectId, "general");
    assert.equal(scratch.title, "Notes");

    // Unchanged re-collection: no bumps, no planner-changed publish.
    const changesBefore = harness.busEvents.filter((event) => event.kind === "planner-changed").length;
    const again = await harness.service.collectPlanArtifacts(plan.planId);
    assert.equal(again.find((artifact) => artifact.relPath === "architecture/overview.md")?.revision, 1);
    assert.equal(harness.busEvents.filter((event) => event.kind === "planner-changed").length, changesBefore);

    // Change one file: its revision bumps, artifact id is preserved.
    await writeFile(path.join(workspace, "plan", "architecture", "overview.md"), "# Architecture Overview\n\nRevised.\n", "utf8");
    const revised = await harness.service.collectPlanArtifacts(plan.planId);
    const revisedDoc = revised.find((artifact) => artifact.relPath === "architecture/overview.md");
    assert.ok(revisedDoc);
    assert.equal(revisedDoc.revision, 2);
    assert.equal(revisedDoc.artifactId, doc.artifactId);

    // Deleting the file never deletes the row.
    await rm(path.join(workspace, "plan", "scratch", "notes.md"));
    const afterDelete = await harness.service.collectPlanArtifacts(plan.planId);
    assert.ok(afterDelete.some((artifact) => artifact.relPath === "scratch/notes.md"));
  } finally {
    harness.connection.close();
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("a fresh session is hydrated from the store before its first turn", async () => {
  const harness = await makeHarness();
  try {
    const plan = await harness.service.createPlan({ brief: "b", aspectIds: ["architecture"], contextRoots: [] });
    const first = path.join(harness.dir, "ws-a");
    await mkdir(first, { recursive: true });
    harness.setWorkspace(first);
    await harness.service.startPlanSession(plan.planId);
    await seedPlanFiles(first);
    await harness.service.collectPlanArtifacts(plan.planId);

    // The session dies (sandbox crash / window reload); a new workspace boots.
    harness.sessions.kill("session-1");
    const second = path.join(harness.dir, "ws-b");
    await mkdir(second, { recursive: true });
    harness.setWorkspace(second);
    await harness.service.sendPlanTurn(plan.planId, "continue");
    assert.equal(harness.sessions.reclaims, 1);

    const doc = await readFile(path.join(second, "plan", "architecture", "overview.md"), "utf8");
    assert.ok(doc.includes("The shape of it."));
    const image = await readFile(path.join(second, "plan", "ui-ux", "mock.png"));
    assert.equal(image[0], 0x89);
    assert.equal(harness.sessions.prompts.at(-1), "continue");
  } finally {
    harness.connection.close();
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("sendInstructions composes one turn from open annotations and delegates them", async () => {
  const harness = await makeHarness();
  try {
    const plan = await harness.service.createPlan({ brief: "b", aspectIds: ["architecture"], contextRoots: [] });
    const workspace = path.join(harness.dir, "ws");
    await mkdir(workspace, { recursive: true });
    harness.setWorkspace(workspace);
    await harness.service.startPlanSession(plan.planId);
    await seedPlanFiles(workspace);
    const collected = await harness.service.collectPlanArtifacts(plan.planId);
    const doc = collected.find((artifact) => artifact.relPath === "architecture/overview.md");
    assert.ok(doc);

    const open = await harness.service.addAnnotation(plan.planId, doc.artifactId, "block:2", "Split phase two.");
    const parked = await harness.service.addAnnotation(plan.planId, doc.artifactId, "node:Gateway", "Maybe later.");
    await harness.service.setAnnotationStatus(parked.annotationId, "wont-fix");

    const result = await harness.service.sendInstructions(plan.planId);
    assert.equal(result.sentCount, 1);
    const turn = harness.sessions.prompts.at(-1) ?? "";
    assert.ok(turn.includes("Reviewer instructions"));
    assert.ok(turn.includes("Architecture Overview"));
    assert.ok(turn.includes("block 2"));
    assert.ok(turn.includes("Split phase two."));
    assert.ok(!turn.includes("Maybe later."));

    const state = await harness.service.getPlanState(plan.planId);
    const delegated = state.annotations.find((annotation) => annotation.annotationId === open.annotationId);
    assert.ok(delegated);
    assert.equal(delegated.status, "delegated");
    assert.equal(delegated.delegatedRev, doc.revision);

    // Nothing open → accepted no-op, no extra turn.
    const before = harness.sessions.prompts.length;
    assert.deepEqual(await harness.service.sendInstructions(plan.planId), { sentCount: 0 });
    assert.equal(harness.sessions.prompts.length, before);
  } finally {
    harness.connection.close();
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("aspect registry: create slugs unique ids, overlay merges read-only, archive filters", async () => {
  const harness = await makeHarness();
  try {
    const created = await harness.service.saveAspect({
      label: "Brand review",
      instructions: "Check the visuals against the brand book.",
      expectedArtifacts: ["Brand notes (document)"]
    });
    assert.ok(created.some((aspect) => aspect.aspectId === "brand-review" && !aspect.seeded));
    // Same label again: the id dedupes rather than clobbering.
    const again = await harness.service.saveAspect({ label: "Brand review", instructions: "x", expectedArtifacts: [] });
    assert.ok(again.some((aspect) => aspect.aspectId === "brand-review-2"));

    const archived = await harness.service.archiveAspect("performance", true);
    const performance = archived.find((aspect) => aspect.aspectId === "performance");
    assert.ok(performance);
    assert.equal(performance.archived, true);
    const active = await harness.service.listAspects(false);
    assert.ok(!active.some((aspect) => aspect.aspectId === "performance"));

    // Renames on seeded rows persist (seeded flag kept for provenance).
    const renamed = await harness.service.saveAspect({
      aspectId: "testing",
      label: "Testing & proof",
      instructions: "Prove it works.",
      expectedArtifacts: ["Test plan (document)"]
    });
    const testing = renamed.find((aspect) => aspect.aspectId === "testing");
    assert.ok(testing);
    assert.equal(testing.label, "Testing & proof");
    assert.equal(testing.seeded, true);
  } finally {
    harness.connection.close();
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("artifact rename overrides and clears; scripts toggle guards kind", async () => {
  const harness = await makeHarness();
  try {
    const plan = await harness.service.createPlan({ brief: "b", aspectIds: [], contextRoots: [] });
    const workspace = path.join(harness.dir, "ws");
    await mkdir(workspace, { recursive: true });
    harness.setWorkspace(workspace);
    await harness.service.startPlanSession(plan.planId);
    await seedPlanFiles(workspace);
    const collected = await harness.service.collectPlanArtifacts(plan.planId);
    const doc = collected.find((artifact) => artifact.relPath === "architecture/overview.md");
    const prototype = collected.find((artifact) => artifact.kind === "prototype");
    assert.ok(doc);
    assert.ok(prototype);

    const renamed = await harness.service.renameArtifact(doc.artifactId, "The Plan");
    assert.equal(renamed.title, "The Plan");
    // A re-collection keeps the override.
    await harness.service.collectPlanArtifacts(plan.planId);
    const state = await harness.service.getPlanState(plan.planId);
    assert.equal(state.artifacts.find((artifact) => artifact.artifactId === doc.artifactId)?.title, "The Plan");
    const cleared = await harness.service.renameArtifact(doc.artifactId, "");
    assert.equal(cleared.title, "Architecture Overview");

    const toggled = await harness.service.setPrototypeScripts(prototype.artifactId, true);
    assert.equal(toggled.scriptsEnabled, true);
    await assert.rejects(
      () => harness.service.setPrototypeScripts(doc.artifactId, true),
      /Only prototype artifacts/
    );
  } finally {
    harness.connection.close();
    await rm(harness.dir, { recursive: true, force: true });
  }
});
