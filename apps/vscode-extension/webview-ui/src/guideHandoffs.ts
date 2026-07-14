/** Shared final step that lets a completed panel guide continue elsewhere. */

import type { PanelRequestPayload, PanelResponse } from "@drydock/contracts";
import type { HelpTourAction, HelpTourStep } from "./help.js";

type Workflow = "taskBoard" | "agents" | "planner" | "taskReview";
type Request = (payload: PanelRequestPayload) => Promise<PanelResponse>;

export interface GuideHandoffContext {
  readonly current: Workflow;
  readonly request: Request;
  readonly taskId?: () => string | undefined;
  readonly planId?: () => string | undefined;
}

const descriptions: Record<Workflow, string> = {
  taskBoard: "Stages, dependencies, starting work, and verification.",
  agents: "Fleet status, attention, session navigation, and landing.",
  planner: "Plan intake, artifacts, revisions, and board handoff.",
  taskReview: "Changed files, comments, and revision dispatch."
};

const labels: Record<Workflow, string> = {
  taskBoard: "Task Board guide",
  agents: "Agents guide",
  planner: "Planner guide",
  taskReview: "Task Review guide"
};

async function requireAccepted(request: Request, payload: PanelRequestPayload): Promise<void> {
  const response = await request(payload);
  if (!response.ok) throw new Error(response.error.message);
}

function payloadFor(workflow: Workflow, context: GuideHandoffContext): PanelRequestPayload {
  switch (workflow) {
    case "taskBoard":
      return { type: "taskBoard.open", startGuide: true };
    case "agents":
      return { type: "agents.open", startGuide: true };
    case "planner": {
      const planId = context.planId?.();
      return { type: "planner.open", ...(planId === undefined ? {} : { planId }), startGuide: true };
    }
    case "taskReview": {
      const taskId = context.taskId?.();
      if (taskId === undefined) throw new Error("The guide needs a task before Task Review can open.");
      return { type: "taskReview.open", taskId, startGuide: true };
    }
  }
}

export function nextWorkflowStep(context: GuideHandoffContext): HelpTourStep {
  const workflows: readonly Workflow[] = ["taskBoard", "agents", "planner", "taskReview"];
  const actions: HelpTourAction[] = workflows
    .filter((workflow) => workflow !== context.current)
    .map((workflow) => ({
      label: labels[workflow],
      description: descriptions[workflow],
      run: () => requireAccepted(context.request, payloadFor(workflow, context))
    }));
  return {
    title: "Next workflow",
    body: "Choose the next workflow to explore",
    target: () => document.querySelector<HTMLElement>(".dd-help-launcher") ?? document.body,
    nextLabel: "Finish here",
    actions
  };
}
