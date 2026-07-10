/**
 * Planner store tests: record round-trips, partial updates, seed idempotence,
 * and durability across a database reopen (the crash-survival contract).
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  asId,
  SEEDED_PLAN_ASPECTS,
  type PlanAnnotationId,
  type PlanArtifactId,
  type PlanId
} from "@drydock/contracts";
import { applyMigrations } from "./migrations.js";
import {
  SqlitePlanAnnotationStore,
  SqlitePlanArtifactStore,
  SqlitePlanAspectStore,
  SqlitePlanStore
} from "./plannerStore.js";
import { SqliteConnection } from "./sqliteConnection.js";

const PLAN_ID = asId<"PlanId">("plan-1") as PlanId;
const ARTIFACT_ID = asId<"PlanArtifactId">("artifact-1") as PlanArtifactId;
const ANNOTATION_ID = asId<"PlanAnnotationId">("annotation-1") as PlanAnnotationId;

test("planner records round-trip and survive a database reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "planner.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);

    const plans = new SqlitePlanStore(connection);
    await plans.insertPlan({
      planId: PLAN_ID,
      title: "Auth revamp",
      brief: "Replace the legacy cookie stack.",
      aspectIds: ["architecture", "testing"],
      contextRoots: ["C:\\repos\\app\\src"],
      notes: "OIDC only.",
      status: "draft",
      sessionId: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    });
    await plans.updatePlan(PLAN_ID, {
      status: "active",
      sessionId: asId<"SessionId">("session-9"),
      updatedAt: "2026-07-10T01:00:00.000Z"
    });

    const artifacts = new SqlitePlanArtifactStore(connection);
    await artifacts.upsertArtifact({
      artifactId: ARTIFACT_ID,
      planId: PLAN_ID,
      relPath: "architecture/overview.md",
      kind: "document",
      aspectId: "architecture",
      title: "Architecture Overview",
      titleOverride: null,
      revision: 1,
      content: "# Architecture Overview\n\nBody.",
      blobSha256: null,
      byteSize: null,
      mime: null,
      scriptsEnabled: false,
      collectedAt: "2026-07-10T01:00:00.000Z"
    });
    await artifacts.setTitleOverride(ARTIFACT_ID, "The Plan");
    await artifacts.setScriptsEnabled(ARTIFACT_ID, true);

    const annotations = new SqlitePlanAnnotationStore(connection);
    await annotations.insertAnnotation({
      annotationId: ANNOTATION_ID,
      planId: PLAN_ID,
      artifactId: ARTIFACT_ID,
      anchor: "block:3",
      body: "Split phase 2.",
      status: "open",
      delegatedRev: null,
      createdAt: "2026-07-10T01:05:00.000Z",
      updatedAt: "2026-07-10T01:05:00.000Z"
    });
    await annotations.updateAnnotation(ANNOTATION_ID, {
      status: "delegated",
      delegatedRev: 1,
      updatedAt: "2026-07-10T01:10:00.000Z"
    });

    connection.close();

    // Reopen: rows must survive, and re-running migrations must be a no-op.
    const reopened = new SqliteConnection(dbPath);
    applyMigrations(reopened);

    const plan = await new SqlitePlanStore(reopened).getPlan(PLAN_ID);
    assert.ok(plan);
    assert.equal(plan.status, "active");
    assert.equal(plan.sessionId, "session-9");
    assert.deepEqual(plan.aspectIds, ["architecture", "testing"]);
    assert.equal(plan.notes, "OIDC only.");

    const artifact = await new SqlitePlanArtifactStore(reopened).getArtifactByPath(PLAN_ID, "architecture/overview.md");
    assert.ok(artifact);
    assert.equal(artifact.artifactId, "artifact-1");
    assert.equal(artifact.titleOverride, "The Plan");
    assert.equal(artifact.scriptsEnabled, true);
    assert.equal(artifact.content, "# Architecture Overview\n\nBody.");

    const annotation = await new SqlitePlanAnnotationStore(reopened).getAnnotation(ANNOTATION_ID);
    assert.ok(annotation);
    assert.equal(annotation.status, "delegated");
    assert.equal(annotation.delegatedRev, 1);

    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aspect registry seeds once and keeps user edits on re-migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "aspects.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const aspects = new SqlitePlanAspectStore(connection);

    const seeded = await aspects.listAspects();
    assert.equal(seeded.length, SEEDED_PLAN_ASPECTS.length);
    assert.ok(seeded.every((aspect) => aspect.seeded));

    // A department adds its own aspect and archives a seeded one.
    await aspects.upsertAspect({
      aspectId: "brand-review",
      label: "Brand review",
      instructions: "Check the visuals against the brand book.",
      expectedArtifacts: ["Brand notes (document)"],
      sortOrder: 20,
      archived: false,
      seeded: false
    });
    await aspects.setArchived("performance", true);

    connection.close();
    const reopened = new SqliteConnection(dbPath);
    // Re-running migrations must NOT restore the archived seed or drop the custom row.
    applyMigrations(reopened);
    const store = new SqlitePlanAspectStore(reopened);

    const active = await store.listAspects();
    assert.ok(active.some((aspect) => aspect.aspectId === "brand-review"));
    assert.ok(!active.some((aspect) => aspect.aspectId === "performance"));
    const all = await store.listAspects(true);
    assert.equal(all.length, SEEDED_PLAN_ASPECTS.length + 1);
    const performance = all.find((aspect) => aspect.aspectId === "performance");
    assert.ok(performance);
    assert.equal(performance.archived, true);

    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deletePlan removes the plan with its artifacts and annotations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drydock-sqlite-"));
  const dbPath = path.join(dir, "delete.sqlite");
  try {
    const connection = new SqliteConnection(dbPath);
    applyMigrations(connection);
    const plans = new SqlitePlanStore(connection);
    const artifacts = new SqlitePlanArtifactStore(connection);
    const annotations = new SqlitePlanAnnotationStore(connection);

    await plans.insertPlan({
      planId: PLAN_ID,
      title: "Doomed",
      brief: "b",
      aspectIds: [],
      contextRoots: [],
      notes: "",
      status: "draft",
      sessionId: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    });
    await artifacts.upsertArtifact({
      artifactId: ARTIFACT_ID,
      planId: PLAN_ID,
      relPath: "general/a.md",
      kind: "document",
      aspectId: "general",
      title: "A",
      titleOverride: null,
      revision: 1,
      content: "x",
      blobSha256: null,
      byteSize: null,
      mime: null,
      scriptsEnabled: false,
      collectedAt: "2026-07-10T00:00:00.000Z"
    });
    await annotations.insertAnnotation({
      annotationId: ANNOTATION_ID,
      planId: PLAN_ID,
      artifactId: ARTIFACT_ID,
      anchor: "block:1",
      body: "note",
      status: "open",
      delegatedRev: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    });

    await plans.deletePlan(PLAN_ID);
    assert.equal(await plans.getPlan(PLAN_ID), null);
    assert.deepEqual(await artifacts.listArtifacts(PLAN_ID), []);
    assert.deepEqual(await annotations.listAnnotations(PLAN_ID), []);

    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
