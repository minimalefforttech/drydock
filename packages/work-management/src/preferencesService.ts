/**
 * Product preferences (background-lane plan D10): the typed rung of the
 * configuration ladder between machine settings and recipes.
 *
 * Ladder, lowest precedence first: built-in defaults, machine settings
 * (VS Code `drydock.*`), THESE preferences, recipe defaults, the ticket,
 * the stage. Studio policy sits outside the ladder and only ever caps.
 * Unset means inherit; junk stored values degrade to absent, never crash.
 */

import type { PreferenceStore, TaskApproach, TaskHandoffMode, TaskLane } from "@drydock/contracts";
import type { Logger } from "@drydock/core";

/** Ticket-shape defaults pre-filling the new-task form (plan D1). */
export interface NewTicketDefaults {
  readonly lane?: TaskLane;
  readonly handoffMode?: TaskHandoffMode;
  readonly approach?: TaskApproach;
}

const NEW_TICKET_DEFAULTS_KEY = "newTicketDefaults";

export class PreferencesService {
  constructor(
    private readonly store: PreferenceStore,
    private readonly logger: Logger
  ) {}

  async getNewTicketDefaults(): Promise<NewTicketDefaults> {
    const raw = await this.store.getPreference(NEW_TICKET_DEFAULTS_KEY);
    if (raw === null) return {};
    try {
      const value = JSON.parse(raw) as unknown;
      if (typeof value !== "object" || value === null) return {};
      const candidate = value as Record<string, unknown>;
      return {
        ...(candidate["lane"] === "normal" || candidate["lane"] === "background" ? { lane: candidate["lane"] as TaskLane } : {}),
        ...(candidate["handoffMode"] === "patch" || candidate["handoffMode"] === "branch" ? { handoffMode: candidate["handoffMode"] as TaskHandoffMode } : {}),
        ...(candidate["approach"] === "implement" || candidate["approach"] === "plan-first" ? { approach: candidate["approach"] as TaskApproach } : {})
      };
    } catch {
      this.logger.warn("newTicketDefaults preference is not valid JSON; using built-in defaults");
      return {};
    }
  }

  /** Persists only the recognized fields; an empty object clears the key. */
  async setNewTicketDefaults(defaults: NewTicketDefaults): Promise<void> {
    const value = {
      ...(defaults.lane === undefined ? {} : { lane: defaults.lane }),
      ...(defaults.handoffMode === undefined ? {} : { handoffMode: defaults.handoffMode }),
      ...(defaults.approach === undefined ? {} : { approach: defaults.approach })
    };
    await this.store.setPreference(
      NEW_TICKET_DEFAULTS_KEY,
      Object.keys(value).length === 0 ? null : JSON.stringify(value)
    );
  }
}
