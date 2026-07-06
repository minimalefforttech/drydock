/**
 * Inert host-side model catalog discovery.
 *
 * Spawns the host Codex CLI's app-server, performs the initialize handshake,
 * pages model/list, and stops — pure capability discovery, allowed by the
 * threat model. No thread is created and no prompt or model output ever flows
 * through this path.
 */

import type { AgentModelCatalog } from "@drydock/contracts";
import { initializeCodexAppServer, requestCodexModelCatalog } from "./codexAppServerTransport.js";
import { LineJsonRpcClient } from "./jsonRpcClient.js";

export interface FetchCodexHostModelCatalogOptions {
  readonly codexPath: string;
  readonly cwd: string;
  readonly isoNow?: () => string;
}

export async function fetchCodexHostModelCatalog(options: FetchCodexHostModelCatalogOptions): Promise<AgentModelCatalog> {
  const client = new LineJsonRpcClient(options.codexPath, ["app-server", "--listen", "stdio://"], options.cwd);
  await client.start();
  try {
    await initializeCodexAppServer(client);
    const catalog = await requestCodexModelCatalog(client, options.isoNow ?? (() => new Date().toISOString()));
    return {
      ...catalog,
      diagnostics: [
        ...catalog.diagnostics,
        "Models listed via inert host app-server capability discovery; prompts never leave the micro-VM path."
      ]
    };
  } finally {
    await client.stop();
  }
}
