import assert from "node:assert/strict";
import test from "node:test";
import { asId, type BoardColumnRecord, type SubtaskRecord } from "@drydock/contracts";
import type { SubtaskService } from "@drydock/work-management";
import { toSubtaskSummary } from "./boardShared.js";

const NOW = "2026-07-14T09:00:00.000Z";
const reviewColumn: BoardColumnRecord = {
  columnId: asId<"ColumnId">("col-review"),
  name: "Review",
  category: "done",
  sortOrder: 4
};
const service = {
  isBlocked: () => false
} as unknown as SubtaskService;

function record(verifiedAt?: string): SubtaskRecord {
  return {
    subtaskId: asId<"SubtaskId">("sub-verify"),
    taskId: asId<"TaskId">("task-1"),
    title: "Verify the result",
    origin: "manual",
    autoStart: false,
    columnId: reviewColumn.columnId,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    doneAt: NOW,
    verifyMode: "hitl",
    ...(verifiedAt === undefined ? {} : { verifiedAt })
  };
}

function project(input: SubtaskRecord) {
  return toSubtaskSummary(
    input,
    service,
    [],
    new Map([[input.subtaskId, input]]),
    new Map([[reviewColumn.columnId, reviewColumn]]),
    [],
    { isRunning: false }
  );
}

test("verification projection distinguishes waiting from the durable verified receipt", () => {
  const waiting = project(record());
  assert.equal(waiting.verifyUnmet, true);
  assert.equal(waiting.verifiedAt, undefined);

  const verified = project(record(NOW));
  assert.equal(verified.verifyUnmet, undefined);
  assert.equal(verified.verifiedAt, NOW);
});
