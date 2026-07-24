/**
 * Product preferences (background-lane plan D10).
 *
 * One rung of the configuration ladder: studio policy caps everything,
 * machine facts live in VS Code settings, WORKFLOW DEFAULTS live here
 * (sqlite-backed product data, team-shareable later the way
 * `.drydock/recipes.json` overlays are), recipes override preferences, the
 * ticket overrides recipes, the stage overrides the ticket. Unset at any
 * rung means inherit from the rung below.
 *
 * Storage is a validated JSON-per-key KV; the typed accessors live in
 * @drydock/work-management's PreferencesService so junk rows degrade to
 * defaults instead of crashing consumers.
 */

export interface PreferenceStore {
  getPreference(key: string): Promise<string | null>;
  /** null deletes the key (revert to inherited default). */
  setPreference(key: string, valueJson: string | null): Promise<void>;
  listPreferences(): Promise<{ readonly key: string; readonly valueJson: string }[]>;
}
