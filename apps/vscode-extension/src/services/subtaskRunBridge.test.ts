import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type ChatSessionRecord, type TaskClonePolicy } from "@drydock/contracts";
import { MemoryLogger } from "@drydock/core";
import { createSubtaskRunBridge } from "./subtaskRunBridge.js";

test("subtask runs resolve the durable task policy into a clone workspace", async () => {
  const policy: TaskClonePolicy = {
    workspaceSetId: asId<"WorkspaceSetId">("set-1"),
    projectIds: [asId<"ProjectId">("project-b")],
    dirtyHandling: "carry"
  };
  let startedWorkspace: unknown;
  let resolvedPolicy: TaskClonePolicy | undefined;
  const sent: string[] = [];
  const startRun = createSubtaskRunBridge({
    logger: new MemoryLogger(),
    tasks: { requireClonePolicy: async () => policy },
    workspaces: {
      resolveTaskCloneWorkspace: async (input) => {
        resolvedPolicy = input;
        return { workspaceSetId: "set-1", mode: "clone", roots: ["/work/project-b"], dirtyHandling: "carry" };
      }
    },
    sessions: {
      startChat: async (_prompt, _model, workspace) => {
        startedWorkspace = workspace;
        return { session: session("session-1") };
      },
      sendChatTurn: async (_sessionId, prompt) => { sent.push(prompt); }
    }
  });

  const result = await startRun({ taskId: "task-1", subtaskId: "sub-1", prompt: "Implement it", title: "Worker" });
  await Promise.resolve();

  assert.equal(result.sessionId, "session-1");
  assert.deepEqual(resolvedPolicy, policy);
  assert.deepEqual(startedWorkspace, {
    workspaceSetId: "set-1",
    mode: "clone",
    roots: ["/work/project-b"],
    dirtyHandling: "carry"
  });
  assert.deepEqual(sent, ["Implement it"]);
});

test("subtask runs fail actionably instead of falling back to an empty workspace", async () => {
  let starts = 0;
  const startRun = createSubtaskRunBridge({
    logger: new MemoryLogger(),
    tasks: {
      requireClonePolicy: async () => {
        throw new Error("Task task-1 must link exactly one workspace set before it can start an isolated clone run; found 0.");
      }
    },
    workspaces: {
      resolveTaskCloneWorkspace: async () => { throw new Error("unreachable"); }
    },
    sessions: {
      startChat: async () => {
        starts += 1;
        return { session: session("session-1") };
      },
      sendChatTurn: async () => undefined
    }
  });

  await assert.rejects(
    () => startRun({ taskId: "task-1", subtaskId: "sub-1", prompt: "Implement it", title: "Worker" }),
    /must link exactly one workspace set/
  );
  assert.equal(starts, 0);
});

function session(sessionId: string): ChatSessionRecord {
  return {
    sessionId: asId<"SessionId">(sessionId),
    chatId: asId<"ChatId">(`chat-${sessionId}`),
    title: "Worker",
    status: "active",
    providerId: "codex",
    transport: "codex-app-server",
    mode: "clone",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}
