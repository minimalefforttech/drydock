import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type AgentQuestionRecord, type TurnResult, type WorkTaskRecord } from "@drydock/contracts";
import { MemoryLogger, ProductEventBus } from "@drydock/core";
import { TaskFaqAutoAnswerCoordinator, taskFaqPatternMatches } from "./taskFaqAutoAnswer.js";

const taskId = asId<"TaskId">("task-1");
const sessionId = asId<"SessionId">("session-1");
const questionId = asId<"AgentQuestionId">("question-1");

test("FAQ answers wait for the active turn and resolve only after dispatch", async () => {
  const bus = new ProductEventBus();
  const answered: string[] = [];
  const prompts: string[] = [];
  let active = true;
  let finishDispatch: ((result: TurnResult) => void) | undefined;
  const dispatch = new Promise<TurnResult>((resolve) => { finishDispatch = resolve; });
  const question = pendingQuestion("Which branch should I use?");

  const coordinator = new TaskFaqAutoAnswerCoordinator({
    bus,
    tasks: taskPort(),
    faqs: faqPort("which branch", "Use feature/release."),
    questions: questionPort(question, answered),
    sessions: {
      isChatSessionLive: () => true,
      hasActiveChatTurn: () => active,
      sendChatTurn: (_sessionId, prompt) => {
        prompts.push(prompt);
        return dispatch;
      }
    },
    logger: new MemoryLogger(),
    enabled: () => true
  });

  bus.publish({ kind: "question-asked", question });
  await settle();
  assert.deepEqual(prompts, []);
  assert.deepEqual(answered, []);

  active = false;
  bus.publish({ kind: "turn-completed", sessionId, runId: asId<"RunId">("run-1"), status: "completed" });
  await waitFor(() => prompts.length === 1);
  assert.deepEqual(answered, []);

  finishDispatch?.(turnResult("completed"));
  await waitFor(() => answered.length === 1);
  assert.equal(answered[0], "Use feature/release.");
  assert.match(prompts[0] ?? "", /Auto-answered from the task FAQ/);
  coordinator.dispose();
});

test("a rejected FAQ dispatch leaves the durable question pending", async () => {
  const bus = new ProductEventBus();
  const answered: string[] = [];
  const question = pendingQuestion("Which branch?");
  const coordinator = new TaskFaqAutoAnswerCoordinator({
    bus,
    tasks: taskPort(),
    faqs: faqPort("which branch", "Use main."),
    questions: questionPort(question, answered),
    sessions: {
      isChatSessionLive: () => true,
      hasActiveChatTurn: () => false,
      sendChatTurn: () => Promise.reject(new Error("adapter unavailable"))
    },
    logger: new MemoryLogger(),
    enabled: () => true
  });

  bus.publish({ kind: "question-asked", question });
  await settle();
  await settle();
  assert.deepEqual(answered, []);
  coordinator.dispose();
});

for (const status of ["failed", "cancelled"] as const) {
  test(`a ${status} FAQ turn leaves the durable question pending`, async () => {
    const bus = new ProductEventBus();
    const answered: string[] = [];
    const prompts: string[] = [];
    const question = pendingQuestion("Which branch?");
    const coordinator = new TaskFaqAutoAnswerCoordinator({
      bus,
      tasks: taskPort(),
      faqs: faqPort("which branch", "Use main."),
      questions: questionPort(question, answered),
      sessions: {
        isChatSessionLive: () => true,
        hasActiveChatTurn: () => false,
        sendChatTurn: (_sessionId, prompt) => {
          prompts.push(prompt);
          return Promise.resolve(turnResult(status));
        }
      },
      logger: new MemoryLogger(),
      enabled: () => true
    });

    bus.publish({ kind: "question-asked", question });
    await waitFor(() => prompts.length === 1);
    await settle();
    assert.deepEqual(answered, []);
    coordinator.dispose();
  });
}

test("FAQ phrase matching uses token boundaries", () => {
  assert.equal(taskFaqPatternMatches("Yes, continue", "yes"), true);
  assert.equal(taskFaqPatternMatches("I finished yesterday", "yes"), false);
  assert.equal(taskFaqPatternMatches("Which BRANCH should I use?", "which branch"), true);
  assert.equal(taskFaqPatternMatches("anything", ""), false);
});

function pendingQuestion(question: string): AgentQuestionRecord {
  return {
    questionId,
    sessionId,
    question,
    options: [],
    status: "pending",
    createdAt: "2026-07-14T00:00:00.000Z"
  };
}

function turnResult(status: TurnResult["status"]): TurnResult {
  return {
    runId: asId<"RunId">(`faq-${status}`),
    status,
    eventCount: 1
  };
}

function taskPort() {
  const task: WorkTaskRecord = {
    taskId,
    title: "Release",
    state: "in-progress",
    columnId: asId<"ColumnId">("col-progress"),
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    autoAnswerFaq: true
  };
  return {
    listLinks: () => Promise.resolve([{ taskId, sessionId, createdAt: "2026-07-14T00:00:00.000Z" }]),
    getTask: () => Promise.resolve(task)
  };
}

function faqPort(pattern: string, answer: string) {
  return {
    listForTask: () => Promise.resolve([{
      faqId: "faq-1",
      taskId,
      pattern,
      answer,
      createdAt: "2026-07-14T00:00:00.000Z"
    }])
  };
}

function questionPort(question: AgentQuestionRecord, answered: string[]) {
  return {
    listQuestions: () => Promise.resolve(answered.length === 0 ? [question] : []),
    answer: async (_questionId: typeof questionId, answer: string) => {
      answered.push(answer);
      return { ...question, status: "answered" as const, answer, resolvedAt: "2026-07-14T00:00:01.000Z" };
    }
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("Timed out waiting for asynchronous FAQ coordination.");
}
