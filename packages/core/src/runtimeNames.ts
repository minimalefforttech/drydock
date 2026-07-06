/**
 * Runtime naming helpers.
 *
 * Names intentionally include only opaque ID fragments and role labels.
 */

import type { AgentRole, RuntimeGenerationId, SessionId } from "@drydock/contracts";
import { idFragment } from "./ids.js";

export function buildRuntimeName(prefix: string, sessionId: SessionId, generationId: RuntimeGenerationId, role: AgentRole): string {
  const safeRole = role.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `${prefix}-${idFragment(sessionId)}-${idFragment(generationId)}-${safeRole}`.toLowerCase();
}

