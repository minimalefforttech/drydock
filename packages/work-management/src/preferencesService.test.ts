/**
 * PreferencesService tests (plan D10): typed roundtrip, junk tolerance
 * (bad JSON and wrong enums degrade to built-ins, never crash), and
 * clearing back to inherit.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import type { PreferenceStore } from "@drydock/contracts";
import { MemoryLogger } from "@drydock/core";
import { PreferencesService } from "./preferencesService.js";

class FakePreferenceStore implements PreferenceStore {
  readonly map = new Map<string, string>();

  async getPreference(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async setPreference(key: string, valueJson: string | null): Promise<void> {
    if (valueJson === null) this.map.delete(key);
    else this.map.set(key, valueJson);
  }

  async listPreferences(): Promise<{ key: string; valueJson: string }[]> {
    return [...this.map.entries()].map(([key, valueJson]) => ({ key, valueJson }));
  }
}

test("new-ticket defaults roundtrip, tolerate junk, and clear to inherit", async () => {
  const store = new FakePreferenceStore();
  const service = new PreferencesService(store, new MemoryLogger());

  assert.deepEqual(await service.getNewTicketDefaults(), {});

  await service.setNewTicketDefaults({ lane: "background", handoffMode: "branch", approach: "plan-first" });
  assert.deepEqual(await service.getNewTicketDefaults(), {
    lane: "background",
    handoffMode: "branch",
    approach: "plan-first"
  });

  // Junk in storage degrades to built-ins, never crashes a consumer.
  store.map.set("newTicketDefaults", "{not json");
  assert.deepEqual(await service.getNewTicketDefaults(), {});
  store.map.set("newTicketDefaults", JSON.stringify({ lane: "turbo", handoffMode: "branch" }));
  assert.deepEqual(await service.getNewTicketDefaults(), { handoffMode: "branch" });

  // An empty set clears the key entirely (inherit from the rung below).
  await service.setNewTicketDefaults({});
  assert.equal(store.map.has("newTicketDefaults"), false);
});
