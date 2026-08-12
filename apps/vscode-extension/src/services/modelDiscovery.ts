/**
 * Host-side live model discovery for ridden providers.
 *
 * Each rider's registry descriptor names an OpenAI-models-shaped endpoint
 * (`GET → { data: [{ id, ... }] }`) and how it is authorized: public, or a
 * bearer key read from VS Code SecretStorage. This is inert capability
 * discovery - no prompt or workspace data rides these requests, matching the
 * threat model's host-side rules. Failures return an "unavailable" catalog
 * carrying the reason; there are no invented model lists.
 */

import type { AgentModelCatalog, AgentModelSummary, ProviderDescriptor } from "@drydock/contracts";
import type { Logger } from "@drydock/core";
import type { ProviderSecretRefStore } from "./isolatedRunService.js";

const DISCOVERY_TIMEOUT_MS = 10_000;

export interface ModelDiscoveryDeps {
  readonly providerSecrets?: ProviderSecretRefStore;
  readonly logger: Logger;
  readonly isoNow: () => string;
}

export async function fetchProviderModelsFromHost(
  descriptor: ProviderDescriptor,
  deps: ModelDiscoveryDeps
): Promise<AgentModelCatalog> {
  const discovery = descriptor.discovery;
  if (discovery === undefined) {
    return unavailable(descriptor, deps.isoNow(), `${descriptor.displayName} has no live model discovery endpoint; type a model id from its docs.`);
  }
  let authorization: string | undefined;
  if (discovery.auth === "vscode-secret") {
    const key = await deps.providerSecrets?.get(descriptor.providerId);
    if (key === undefined || key.length === 0) {
      return unavailable(descriptor, deps.isoNow(), `Connect ${descriptor.displayName} (add its API key) to list its models.`);
    }
    authorization = `Bearer ${key}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(discovery.url, {
      signal: controller.signal,
      ...(authorization === undefined ? {} : { headers: { Authorization: authorization } })
    });
    if (!response.ok) {
      deps.logger.warn("provider model discovery rejected", { providerId: descriptor.providerId, status: response.status });
      return unavailable(
        descriptor,
        deps.isoNow(),
        `${discoveryHost(discovery.url)} answered ${String(response.status)}${response.status === 401 || response.status === 403 ? " - check the API key on the connect card" : ""}.`
      );
    }
    const body = await response.json() as { readonly data?: readonly unknown[] };
    const models = (body.data ?? [])
      .map(parseModelEntry)
      .filter((model): model is AgentModelSummary => model !== null);
    if (models.length === 0) {
      return unavailable(descriptor, deps.isoNow(), `${discoveryHost(discovery.url)} answered without any models.`);
    }
    return {
      providerId: descriptor.providerId,
      displayName: descriptor.displayName,
      models,
      refreshedAt: deps.isoNow(),
      source: "provider",
      diagnostics: [`Live model list from ${discoveryHost(discovery.url)}.`]
    };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? `timed out after ${String(DISCOVERY_TIMEOUT_MS / 1000)}s`
      : error instanceof Error ? error.message : String(error);
    deps.logger.warn("provider model discovery failed", { providerId: descriptor.providerId, error: reason });
    return unavailable(descriptor, deps.isoNow(), `Model discovery against ${discoveryHost(discovery.url)} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseModelEntry(entry: unknown): AgentModelSummary | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const id = typeof record["id"] === "string" && record["id"].length > 0 ? record["id"] : null;
  if (id === null) return null;
  // OpenRouter uses `name`, others use `display_name` or nothing.
  const displayName = firstNonEmptyString(record["name"], record["display_name"], record["displayName"]) ?? id;
  return { id, displayName, isDefault: false, hidden: false };
}

function firstNonEmptyString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function discoveryHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function unavailable(descriptor: ProviderDescriptor, refreshedAt: string, reason: string): AgentModelCatalog {
  return {
    providerId: descriptor.providerId,
    displayName: descriptor.displayName,
    models: [],
    refreshedAt,
    source: "unavailable",
    diagnostics: [reason]
  };
}
