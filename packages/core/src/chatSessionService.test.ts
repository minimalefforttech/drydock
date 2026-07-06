/**
 * Unit tests for durable chat session orchestration.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  asId,
  type AdapterAuthContext,
  type AdapterDetectionResult,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentConnection,
  type AgentContextMessage,
  type AgentEvent,
  type AgentModelCatalog,
  type AgentPrompt,
  type AuthValidationResult,
  type ChatSessionRecord,
  type ChatSessionStore,
  type ChatSessionUpdate,
  type CommandResult,
  type EventStore,
  type JsonObject,
  type RunId,
  type RuntimeHandle,
  type RuntimeInventoryRecord,
  type RuntimeInventoryStore,
  type RuntimeStatus,
  type RuntimeTemplate,
  type SessionId,
  type StartAgentProtocolRequest,
  type StartRuntimeRequest,
  type StoredEvent
} from "@drydock/contracts";
import { ChatSessionService } from "./chatSessionService.js";
import type { Clock } from "./clock.js";
import { ProductEventBus, type ProductBusEvent } from "./eventBus.js";
import type { IdGenerator } from "./ids.js";
import type { Logger } from "./logger.js";
import type { RuntimeAdapter } from "./runtimeAdapter.js";
import { RuntimeCleanupService } from "./runtimeCleanupService.js";
import { RuntimeLifecycleService } from "./runtimeLifecycleService.js";

test("chat turns append sequenced events and synthesize a terminal event", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  const busEvents: ProductBusEvent[] = [];
  harness.bus.subscribe((event) => busEvents.push(event));

  const session = await harness.service.startSession(sessionRequest());
  const result = await harness.service.sendTurn(session.sessionId, "hello");
  const timeline = await harness.service.getTimeline(session.sessionId);

  assert.equal(result.status, "completed");
  assert.equal(result.eventCount, 2);
  assert.deepEqual(timeline.map((event) => event.eventType), ["user.message", "agent.text", "agent.done"]);
  assert.deepEqual(timeline.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(busEvents.filter((event) => event.kind === "agent-event").length, 2);
  assert.equal(busEvents.filter((event) => event.kind === "transcript-line").length, 1);

  const ended = await harness.service.endSession(session.sessionId, "test");
  assert.equal(ended.status, "ended");
  assert.equal(harness.runtime.removedNames.size, 1);
  assert.equal([...harness.runtime.removedNames][0]?.startsWith("drydock-"), true);
});

test("chat cancellation records a cancelled terminal status", async () => {
  const agent = new FakeAgentAdapter("cancel");
  const harness = createHarness(agent);
  const session = await harness.service.startSession(sessionRequest());

  const running = harness.service.sendTurn(session.sessionId, "long turn");
  await agent.waitForStream();
  await harness.service.cancelTurn(session.sessionId);
  const result = await running;
  const timeline = await harness.service.getTimeline(session.sessionId);

  assert.equal(result.status, "cancelled");
  assert.deepEqual(timeline.map((event) => event.eventType), ["user.message", "agent.error", "agent.done"]);
  assert.equal((timeline[2]?.payload as { readonly status?: string }).status, "cancelled");
});

test("expandSessionMounts restarts only the session runtime with the added mount", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  const session = await harness.service.startSession(sessionRequest());
  assert.equal(harness.runtime.createRequests.length, 1);

  const addedMount = {
    mountId: asId<"MountId">("mount-approved"),
    hostPath: "C:\\shared\\lib",
    runtimePath: "/approved/access-request-test",
    mode: "read-only" as const,
    source: "shared-read" as const,
    approvedBy: "user",
    approvedAt: "2026-07-02T00:00:00.000Z"
  };
  const updated = await harness.service.expandSessionMounts(session.sessionId, [addedMount], "access-request-approved");

  assert.equal(updated.status, "active");
  // Old generation removed, exactly one replacement created with the mount.
  assert.equal(harness.runtime.removedNames.size, 1);
  assert.equal(harness.runtime.createRequests.length, 2);
  const restartTemplate = harness.runtime.createRequests[1]?.template;
  assert.deepEqual(restartTemplate?.mounts.map((mount) => mount.mountId), ["mount-approved"]);

  // A later turn still works against the replacement runtime.
  const result = await harness.service.sendTurn(session.sessionId, "after restart");
  assert.equal(result.status, "completed");
});

test("getSessionMounts projects the live template mounts and is empty off-session", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  const session = await harness.service.startSession(sessionRequest());

  // A fresh session's template carries no mounts.
  assert.deepEqual(harness.service.getSessionMounts(session.sessionId), []);

  await harness.service.expandSessionMounts(session.sessionId, [{
    mountId: asId<"MountId">("mount-approved"),
    hostPath: "C:\\shared\\lib",
    runtimePath: "/approved/access-request-test",
    mode: "read-only" as const,
    source: "shared-read" as const,
    approvedBy: "user",
    approvedAt: "2026-07-02T00:00:00.000Z"
  }], "access-request-approved");

  assert.deepEqual(harness.service.getSessionMounts(session.sessionId), [
    { runtimePath: "/approved/access-request-test", mode: "read-only", hostDisplayPath: "C:\\shared\\lib" }
  ]);

  // An unknown session yields an empty projection rather than throwing.
  assert.deepEqual(harness.service.getSessionMounts(asId<"SessionId">("session-unknown")), []);
});

test("getSessionWorkspacePath returns the live workspace path and null off-session", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  const session = await harness.service.startSession(sessionRequest());

  assert.equal(harness.service.getSessionWorkspacePath(session.sessionId), "C:\\tmp\\workspace");
  assert.equal(harness.service.getSessionWorkspacePath(asId<"SessionId">("session-unknown")), null);

  // Ending the session drops it from the live map, so the path is null again.
  await harness.service.endSession(session.sessionId, "test");
  assert.equal(harness.service.getSessionWorkspacePath(session.sessionId), null);
});

test("rename and setDescription update metadata, bump updatedAt, and publish session-updated", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  const busEvents: ProductBusEvent[] = [];
  harness.bus.subscribe((event) => busEvents.push(event));
  const session = await harness.service.startSession(sessionRequest());

  const renamed = await harness.service.renameSession(session.sessionId, "Renamed chat");
  assert.equal(renamed.title, "Renamed chat");
  assert.ok(renamed.updatedAt >= session.updatedAt);

  const described = await harness.service.setSessionDescription(session.sessionId, "one-line note");
  assert.equal(described.description, "one-line note");

  // Empty string clears the description entirely.
  const cleared = await harness.service.setSessionDescription(session.sessionId, "");
  assert.equal("description" in cleared, false);

  const renameEvents = busEvents.filter(
    (event) => event.kind === "session-updated" && event.session.title === "Renamed chat"
  );
  assert.ok(renameEvents.length >= 1);

  // A later turn keeps the edited title (it is no longer the default "New chat").
  const afterTurn = await harness.service.sendTurn(session.sessionId, "hi");
  assert.equal(afterTurn.status, "completed");
  const listed = await harness.service.listSessions();
  assert.equal(listed.find((record) => record.sessionId === session.sessionId)?.title, "Renamed chat");
});

test("deleteSession ends a live session, removes its events, and publishes session-deleted", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  const busEvents: ProductBusEvent[] = [];
  harness.bus.subscribe((event) => busEvents.push(event));
  const session = await harness.service.startSession(sessionRequest());
  await harness.service.sendTurn(session.sessionId, "leave a trail");
  assert.ok((await harness.service.getTimeline(session.sessionId)).length > 0);

  await harness.service.deleteSession(session.sessionId);

  // The live runtime was cleaned up, the events dropped, the row gone.
  assert.equal(harness.runtime.removedNames.size, 1);
  assert.equal((await harness.service.getTimeline(session.sessionId)).length, 0);
  assert.equal((await harness.service.listSessions()).length, 0);
  assert.equal(busEvents.some((event) => event.kind === "session-deleted" && event.sessionId === session.sessionId), true);

  await assert.rejects(harness.service.deleteSession(session.sessionId), /was not found/);
});

test("cross-provider restart boots the requested provider's adapter and replays context", async () => {
  const codex = new FakeAgentAdapter("no-terminal", "codex");
  const claude = new FakeAgentAdapter("no-terminal", "claude");
  const harness = createHarness(codex, [claude]);
  const session = await harness.service.startSession(sessionRequest());
  await harness.service.sendTurn(session.sessionId, "first question");

  const restarted = await harness.service.restartSession(
    session.sessionId,
    { providerId: "claude", model: "claude-opus-4-8" },
    "provider-switch",
    "claude-exec-json"
  );

  assert.equal(restarted.providerId, "claude");
  assert.equal(restarted.model, "claude-opus-4-8");
  assert.equal(restarted.status, "active");
  // The claude adapter booted a connection and received the replayed history.
  assert.equal(claude.startProtocolCount, 1);
  assert.equal(claude.restoredContexts.length, 1);
  assert.ok((claude.restoredContexts[0] ?? []).some((message) => message.text === "first question"));

  // A later turn runs against the claude backend without provider-mismatch errors.
  const afterSwitch = await harness.service.sendTurn(session.sessionId, "second question");
  assert.equal(afterSwitch.status, "completed");
});

test("resumeSession revives an ended session on a fresh runtime and replays context", async () => {
  const agent = new FakeAgentAdapter("no-terminal");
  const harness = createHarness(agent);
  const busEvents: ProductBusEvent[] = [];
  harness.bus.subscribe((event) => busEvents.push(event));

  const session = await harness.service.startSession(sessionRequest());
  await harness.service.sendTurn(session.sessionId, "first question");
  const ended = await harness.service.endSession(session.sessionId, "test");
  assert.equal(ended.status, "ended");
  const restoredBefore = agent.restoredContexts.length;

  const resumed = await harness.service.resumeSession(resumeRequest(session.sessionId));

  // Same session row, now active again, on a fresh runtime generation.
  assert.equal(resumed.sessionId, session.sessionId);
  assert.equal(resumed.status, "active");
  assert.equal(harness.runtime.createRequests.length, 2);
  // The durable transcript was replayed into the resumed backend.
  assert.equal(agent.restoredContexts.length, restoredBefore + 1);
  assert.ok((agent.restoredContexts.at(-1) ?? []).some((message) => message.text === "first question"));
  assert.ok(busEvents.some((event) => event.kind === "session-updated" && event.session.status === "active"));

  // A turn runs against the resumed backend.
  const afterResume = await harness.service.sendTurn(session.sessionId, "second question");
  assert.equal(afterResume.status, "completed");
});

test("resumeSession rejects a live session and an unknown session", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  const session = await harness.service.startSession(sessionRequest());

  // Live session: resume must not hijack a running backend.
  await assert.rejects(harness.service.resumeSession(resumeRequest(session.sessionId)), /still live/);

  // Unknown session id.
  await assert.rejects(
    harness.service.resumeSession(resumeRequest(asId<"SessionId">("session-missing"))),
    /was not found/
  );
});

test("resumeSession leaves the session failed when the backend boot fails", async () => {
  const agent = new FakeAgentAdapter("no-terminal");
  const harness = createHarness(agent);
  const session = await harness.service.startSession(sessionRequest());
  await harness.service.endSession(session.sessionId, "test");

  agent.failNextStartProtocol = true;
  await assert.rejects(harness.service.resumeSession(resumeRequest(session.sessionId)), /boot failed/);

  // The row is failed and the session is not live.
  const listed = await harness.service.listSessions();
  assert.equal(listed.find((record) => record.sessionId === session.sessionId)?.status, "failed");
  assert.equal(harness.service.isSessionLive(session.sessionId), false);
});

test("reconcile leaves a session with a fresh foreign heartbeat untouched (running elsewhere)", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  // Window A boots and owns the session; its boot heartbeat is recent.
  const session = await harness.service.startSession(sessionRequest());
  assert.equal(harness.service.isSessionLive(session.sessionId), true);

  // Window B (sibling) reconciles over the shared store. The default 60s stale
  // window keeps A's boot heartbeat "fresh", so B must not touch it.
  const sibling = harness.spawnSibling({ hostInstanceId: "host-b" });
  const counts = await sibling.reconcileSessions(new Set(harness.runtime.names));

  assert.deepEqual(counts, { ended: 0, adopted: 0, elsewhere: 1 });
  // A's runtime was never cleaned up and A still holds it live.
  assert.equal(harness.runtime.removedNames.size, 0);
  assert.equal(harness.service.isSessionLive(session.sessionId), true);
  assert.equal(sibling.isSessionLive(session.sessionId), false);
});

test("reconcile ends a stale session whose container is gone", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  const session = await harness.service.startSession(sessionRequest());

  // A stale-heartbeat sibling with an EMPTY external set: the container is gone,
  // so the session is ended exactly as startup reconcile always did.
  const sibling = harness.spawnSibling({ hostInstanceId: "host-b", heartbeatStaleMs: 1 });
  const counts = await sibling.reconcileSessions(new Set<string>());

  assert.deepEqual(counts, { ended: 1, adopted: 0, elsewhere: 0 });
  const stored = await harness.sessionStore.getSession(session.sessionId);
  assert.equal(stored?.status, "ended");
  // Ending released ownership so a later resume is not blocked.
  assert.equal(stored !== null && "hostInstanceId" in stored, false);
  assert.equal(stored !== null && "heartbeatAt" in stored, false);
});

test("reconcile adopts a stale session whose exec-transport container still runs", async () => {
  const claude = new FakeAgentAdapter("no-terminal", "claude");
  const harness = createHarness(claude);
  const session = await harness.service.startSession(execSessionRequest());
  const restoredBefore = claude.restoredContexts.length;
  const startProtocolBefore = claude.startProtocolCount;
  const createRequestsBefore = harness.runtime.createRequests.length;

  // The container is still alive (its external name is in the live set). A stale
  // sibling should reattach to it: no new container, no context restore.
  const sibling = harness.spawnSibling({ hostInstanceId: "host-b", heartbeatStaleMs: 1 });
  const counts = await sibling.reconcileSessions(new Set(harness.runtime.names));

  assert.deepEqual(counts, { ended: 0, adopted: 1, elsewhere: 0 });
  assert.equal(sibling.isSessionLive(session.sessionId), true);
  // startProtocol ran against the existing runtime; no new container was created.
  assert.equal(claude.startProtocolCount, startProtocolBefore + 1);
  assert.equal(harness.runtime.createRequests.length, createRequestsBefore);
  assert.equal(harness.runtime.removedNames.size, 0);
  // Exec transports keep in-container CLI state, so context is NOT replayed.
  assert.equal(claude.restoredContexts.length, restoredBefore);

  // Ownership is now the sibling's, with a fresh heartbeat.
  const stored = await harness.sessionStore.getSession(session.sessionId);
  assert.equal(stored?.status, "active");
  assert.equal(stored?.hostInstanceId, "host-b");
  assert.ok(stored?.heartbeatAt !== undefined);

  // The adopted session takes turns against the reattached backend.
  const result = await sibling.sendTurn(session.sessionId, "after adoption");
  assert.equal(result.status, "completed");
});

test("reconcile ends a stale app-server session even when its container is alive (non-adoptable)", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  // sessionRequest uses codex-app-server, whose live process cannot be reattached.
  const session = await harness.service.startSession(sessionRequest());

  const sibling = harness.spawnSibling({ hostInstanceId: "host-b", heartbeatStaleMs: 1 });
  const counts = await sibling.reconcileSessions(new Set(harness.runtime.names));

  assert.deepEqual(counts, { ended: 1, adopted: 0, elsewhere: 0 });
  assert.equal(sibling.isSessionLive(session.sessionId), false);
  assert.equal((await harness.sessionStore.getSession(session.sessionId))?.status, "ended");
  // The alive container was cleaned up as part of the honest end.
  assert.equal(harness.runtime.removedNames.size, 1);
});

test("end and delete are refused for a session running in another window", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  await harness.service.startSession(sessionRequest());
  const sessionId = asId<"SessionId">("session-test");

  // The sibling never owns the session (fresh foreign heartbeat), so mutating
  // operations must be refused with the specific cross-window message.
  const sibling = harness.spawnSibling({ hostInstanceId: "host-b" });
  await assert.rejects(sibling.endSession(sessionId, "test"), /running in another VS Code window/);
  await assert.rejects(sibling.deleteSession(sessionId), /running in another VS Code window/);

  // The guard runs before any destructive step: the row and runtime survive.
  assert.equal(harness.runtime.removedNames.size, 0);
  assert.equal((await harness.sessionStore.getSession(sessionId))?.status, "active");
});

test("beatOnce stamps a fresh heartbeat for every live session", async () => {
  const harness = createHarness(new FakeAgentAdapter("no-terminal"));
  const session = await harness.service.startSession(sessionRequest());
  const before = (await harness.sessionStore.getSession(session.sessionId))?.heartbeatAt;
  assert.ok(before !== undefined);

  // The tick body is directly invocable (the interval just calls it).
  await harness.service.beatOnce();

  const after = (await harness.sessionStore.getSession(session.sessionId))?.heartbeatAt;
  assert.ok(after !== undefined);
  // The advancing FixedClock guarantees a strictly newer stamp.
  assert.ok(after! > before!, "heartbeat should advance");
});

function resumeRequest(sessionId: SessionId) {
  return {
    sessionId,
    template: template(),
    workspacePath: "C:\\tmp\\workspace",
    workspaceOwnerToken: "owner-token",
    model: { providerId: "codex", model: "gpt-5" },
    transport: "codex-app-server" as const
  };
}

interface Harness {
  readonly service: ChatSessionService;
  readonly bus: ProductEventBus;
  readonly runtime: FakeRuntimeAdapter;
  readonly inventory: MemoryRuntimeInventoryStore;
  readonly sessionStore: MemoryChatSessionStore;
  readonly eventStore: MemoryEventStore;
  readonly clock: FixedClock;
  readonly hostInstanceId: string;
  /**
   * Builds a SECOND service over the same durable stores + runtime, simulating a
   * different window (or a fresh restart) that shares the SQLite state root but
   * starts with an empty in-memory live map. This is the harness for
   * multi-window reconcile/adoption tests.
   */
  spawnSibling(options?: { readonly hostInstanceId?: string; readonly heartbeatStaleMs?: number }): ChatSessionService;
}

function createHarness(
  agentAdapter: FakeAgentAdapter,
  extraAdapters: readonly FakeAgentAdapter[] = [],
  overrides: { readonly hostInstanceId?: string; readonly heartbeatStaleMs?: number } = {}
): Harness {
  const ids = new FixedIds();
  const clock = new FixedClock();
  const logger = new NullLogger();
  const inventory = new MemoryRuntimeInventoryStore();
  const runtime = new FakeRuntimeAdapter();
  const lifecycle = new RuntimeLifecycleService({ clock, inventory, runtimeAdapter: runtime, logger });
  const cleanup = new RuntimeCleanupService({ clock, inventory, runtimeAdapter: runtime, logger });
  const bus = new ProductEventBus();
  const sessionStore = new MemoryChatSessionStore();
  const eventStore = new MemoryEventStore();
  const adapters = new Map<string, AgentAdapter>();
  for (const adapter of [agentAdapter, ...extraAdapters]) {
    adapter.ids = ids;
    adapter.clock = clock;
    adapters.set(adapter.providerId, adapter as AgentAdapter);
  }
  const hostInstanceId = overrides.hostInstanceId ?? "host-this";
  const build = (opts: { readonly hostInstanceId: string; readonly heartbeatStaleMs?: number }): ChatSessionService =>
    new ChatSessionService({
      ids,
      clock,
      logger,
      lifecycle,
      cleanup,
      agentAdapters: adapters,
      eventStore,
      sessionStore,
      inventory,
      bus,
      hostInstanceId: opts.hostInstanceId,
      ...(opts.heartbeatStaleMs === undefined ? {} : { heartbeatStaleMs: opts.heartbeatStaleMs })
    });
  const service = build({ hostInstanceId, ...(overrides.heartbeatStaleMs === undefined ? {} : { heartbeatStaleMs: overrides.heartbeatStaleMs }) });
  const spawnSibling = (options: { readonly hostInstanceId?: string; readonly heartbeatStaleMs?: number } = {}): ChatSessionService =>
    build({
      hostInstanceId: options.hostInstanceId ?? "host-sibling",
      ...(options.heartbeatStaleMs === undefined ? {} : { heartbeatStaleMs: options.heartbeatStaleMs })
    });
  return { service, bus, runtime, inventory, sessionStore, eventStore, clock, hostInstanceId, spawnSibling };
}

function sessionRequest() {
  return {
    template: template(),
    workspacePath: "C:\\tmp\\workspace",
    workspaceOwnerToken: "owner-token",
    title: "Test chat",
    model: { providerId: "codex", model: "gpt-5" },
    transport: "codex-app-server" as const
  };
}

/** A session on an adoptable exec transport (claude), for multi-window adoption tests. */
function execSessionRequest() {
  return {
    template: template(),
    workspacePath: "C:\\tmp\\workspace",
    workspaceOwnerToken: "owner-token",
    title: "Test chat",
    model: { providerId: "claude", model: "claude-opus-4-8" },
    transport: "claude-exec-json" as const
  };
}

function template(): RuntimeTemplate {
  return {
    id: "stage2-test",
    type: "docker-sandbox",
    network: "disabled",
    mounts: [],
    environment: {},
    adapterProviderIds: ["codex"],
    advancedOptions: {}
  };
}

class FakeAgentAdapter implements AgentAdapter {
  readonly providerId: ReturnType<typeof asId<"ProviderId">>;
  ids: IdGenerator = new FixedIds();
  clock: Clock = new FixedClock();
  /** History replayed into this adapter via restoreContext, per invocation. */
  readonly restoredContexts: (readonly AgentContextMessage[])[] = [];
  startProtocolCount = 0;
  private streamStartedResolve: (() => void) | undefined;
  private cancelResolve: (() => void) | undefined;
  private readonly streamStarted = new Promise<void>((resolve) => {
    this.streamStartedResolve = resolve;
  });
  private readonly cancelled = new Promise<void>((resolve) => {
    this.cancelResolve = resolve;
  });

  /** When set, the next startProtocol call rejects (boot-failure tests). */
  failNextStartProtocol = false;

  constructor(private readonly mode: "no-terminal" | "cancel", providerId = "codex") {
    this.providerId = asId<"ProviderId">(providerId);
  }

  detect(): Promise<AdapterDetectionResult> {
    return Promise.resolve({ available: true, diagnostics: [] });
  }

  validateAuth(_context: AdapterAuthContext): Promise<AuthValidationResult> {
    return Promise.resolve({ status: "unknown", secretRefs: [], diagnostics: [] });
  }

  startProtocol(request: StartAgentProtocolRequest): Promise<AgentConnection> {
    if (this.failNextStartProtocol) {
      this.failNextStartProtocol = false;
      return Promise.reject(new Error("boot failed: startProtocol rejected"));
    }
    this.startProtocolCount += 1;
    return Promise.resolve({
      providerId: this.providerId,
      connectionId: `connection-${this.providerId}-${String(this.startProtocolCount)}`,
      sessionId: request.sessionId,
      agentId: request.agentId,
      agentRole: request.agentRole,
      runtime: request.runtime,
      transport: request.transport
    });
  }

  sendPrompt(_connection: AgentConnection, _prompt: AgentPrompt): Promise<RunId> {
    return Promise.resolve(this.ids.runId());
  }

  listModels(_connection: AgentConnection): Promise<AgentModelCatalog> {
    return Promise.resolve({
      providerId: this.providerId,
      displayName: this.providerId,
      models: [{ id: "gpt-5", displayName: "GPT-5", isDefault: true, hidden: false }],
      refreshedAt: this.clock.isoNow(),
      source: "provider",
      diagnostics: []
    });
  }

  restoreContext(_connection: AgentConnection, messages: readonly AgentContextMessage[]): Promise<void> {
    this.restoredContexts.push(messages);
    return Promise.resolve();
  }

  async *streamEvents(connection: AgentConnection, runId: RunId): AsyncIterable<AgentEvent> {
    this.streamStartedResolve?.();
    if (this.mode === "cancel") {
      await this.cancelled;
      throw new Error("Notification wait aborted.");
    }
    yield {
      id: this.ids.eventId(),
      type: "agent.text",
      sessionId: connection.sessionId,
      runId,
      agentId: connection.agentId,
      agentRole: connection.agentRole,
      runtimeId: connection.runtime.runtimeId,
      createdAt: this.clock.isoNow(),
      text: "hello",
      final: true
    };
  }

  cancel(_connection: AgentConnection, _runId: RunId): Promise<void> {
    this.cancelResolve?.();
    return Promise.resolve();
  }

  stop(_connection: AgentConnection, _reason: string): Promise<void> {
    return Promise.resolve();
  }

  summarizeCapabilities(): Promise<AgentCapabilities> {
    return Promise.resolve({
      providerId: this.providerId,
      supportsExecJson: true,
      supportsAppServer: true,
      supportsCancel: true,
      eventFamilies: []
    });
  }

  waitForStream(): Promise<void> {
    return this.streamStarted;
  }
}

class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly adapter = "docker-sandbox" as const;
  readonly names = new Set<string>();
  readonly removedNames = new Set<string>();
  readonly createRequests: StartRuntimeRequest[] = [];

  createRuntime(request: StartRuntimeRequest, externalName: string): Promise<RuntimeHandle> {
    this.createRequests.push(request);
    this.names.add(externalName);
    return Promise.resolve({
      runtimeId: request.runtimeId,
      runtimeGenerationId: request.generationId,
      sessionId: request.sessionId,
      adapter: this.adapter,
      externalName,
      workspacePath: request.workspacePath,
      runtimeCwd: "/workspace",
      mounts: request.template.mounts,
      status: "running"
    });
  }

  stopRuntime(_handle: RuntimeHandle, _reason: string): Promise<CommandResult> {
    return Promise.resolve(commandResult(0));
  }

  removeRuntime(handle: RuntimeHandle, _force: boolean): Promise<CommandResult> {
    this.names.delete(handle.externalName);
    this.removedNames.add(handle.externalName);
    return Promise.resolve(commandResult(0));
  }

  listExternalRuntimeNames(namePrefix: string): Promise<string[]> {
    return Promise.resolve([...this.names].filter((name) => name.startsWith(namePrefix)));
  }
}

class MemoryChatSessionStore implements ChatSessionStore {
  private readonly sessions = new Map<SessionId, ChatSessionRecord>();

  insertSession(record: ChatSessionRecord): Promise<void> {
    this.sessions.set(record.sessionId, record);
    return Promise.resolve();
  }

  updateSession(sessionId: SessionId, update: ChatSessionUpdate): Promise<void> {
    const current = this.sessions.get(sessionId);
    if (current === undefined) return Promise.resolve();
    const next: ChatSessionRecord = {
      ...current,
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.description === undefined || update.description === null ? {} : { description: update.description }),
      ...(update.providerId === undefined ? {} : { providerId: update.providerId }),
      ...(update.model === undefined ? {} : update.model === null ? {} : { model: update.model }),
      ...(update.runtimeId === undefined ? {} : { runtimeId: update.runtimeId }),
      ...(update.hostInstanceId === undefined || update.hostInstanceId === null ? {} : { hostInstanceId: update.hostInstanceId }),
      ...(update.heartbeatAt === undefined || update.heartbeatAt === null ? {} : { heartbeatAt: update.heartbeatAt }),
      updatedAt: update.updatedAt,
      ...(update.endedAt === undefined ? {} : { endedAt: update.endedAt })
    };
    if (update.model === null) delete (next as { model?: string }).model;
    if (update.description === null) delete (next as { description?: string }).description;
    // null clears ownership just like the SQLite store (columns → NULL → omitted).
    if (update.hostInstanceId === null) delete (next as { hostInstanceId?: string }).hostInstanceId;
    if (update.heartbeatAt === null) delete (next as { heartbeatAt?: string }).heartbeatAt;
    this.sessions.set(sessionId, next);
    return Promise.resolve();
  }

  getSession(sessionId: SessionId): Promise<ChatSessionRecord | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null);
  }

  listSessions(limit = 50): Promise<ChatSessionRecord[]> {
    return Promise.resolve([...this.sessions.values()].slice(0, limit));
  }

  deleteSession(sessionId: SessionId): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }
}

class MemoryEventStore implements EventStore {
  private nextSequence = 1;
  private readonly events: StoredEvent[] = [];
  private readonly eventSequences = new Map<string, number>();

  appendAgentEvent(event: AgentEvent): Promise<number> {
    return this.appendStoredEvent({
      id: event.id,
      sessionId: event.sessionId,
      runId: event.runId,
      eventType: event.type,
      createdAt: event.createdAt,
      payload: event as unknown as JsonObject
    });
  }

  appendStoredEvent(event: StoredEvent): Promise<number> {
    const existing = this.eventSequences.get(event.id);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.eventSequences.set(event.id, sequence);
    this.events.push({ ...event, sequence });
    return Promise.resolve(sequence);
  }

  listEvents(sessionId: SessionId, fromSequence?: number): Promise<StoredEvent[]> {
    return Promise.resolve(this.events.filter((event) => {
      if (event.sessionId !== sessionId) return false;
      if (fromSequence === undefined) return true;
      return (event.sequence ?? 0) > fromSequence;
    }));
  }

  deleteSessionEvents(sessionId: SessionId): Promise<number> {
    let deleted = 0;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event !== undefined && event.sessionId === sessionId) {
        this.events.splice(index, 1);
        this.eventSequences.delete(event.id);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}

class MemoryRuntimeInventoryStore implements RuntimeInventoryStore {
  private readonly runtimes = new Map<string, RuntimeInventoryRecord>();

  insertRuntime(record: RuntimeInventoryRecord): Promise<void> {
    this.runtimes.set(record.runtimeId, record);
    return Promise.resolve();
  }

  updateRuntimeStatus(runtimeId: RuntimeInventoryRecord["runtimeId"], status: RuntimeStatus, timestamp: string): Promise<void> {
    const current = this.runtimes.get(runtimeId);
    if (current === undefined) return Promise.resolve();
    this.runtimes.set(runtimeId, {
      ...current,
      status,
      lastSeenAt: timestamp,
      ...(status === "stopped" ? { stoppedAt: timestamp } : {}),
      ...(status === "removed" ? { removedAt: timestamp } : {})
    });
    return Promise.resolve();
  }

  updateRuntimeMetadata(runtimeId: RuntimeInventoryRecord["runtimeId"], patch: JsonObject, timestamp: string): Promise<void> {
    const current = this.runtimes.get(runtimeId);
    if (current === undefined) return Promise.resolve();
    this.runtimes.set(runtimeId, {
      ...current,
      metadata: { ...current.metadata, ...patch },
      lastSeenAt: timestamp
    });
    return Promise.resolve();
  }

  updateCleanupAttempt(runtimeId: RuntimeInventoryRecord["runtimeId"], timestamp: string, failed: boolean): Promise<void> {
    const current = this.runtimes.get(runtimeId);
    if (current === undefined) return Promise.resolve();
    this.runtimes.set(runtimeId, {
      ...current,
      lastCleanupAttemptAt: timestamp,
      cleanupFailureCount: current.cleanupFailureCount + (failed ? 1 : 0)
    });
    return Promise.resolve();
  }

  getRuntime(runtimeId: RuntimeInventoryRecord["runtimeId"]): Promise<RuntimeInventoryRecord | null> {
    return Promise.resolve(this.runtimes.get(runtimeId) ?? null);
  }

  listRuntimes(): Promise<RuntimeInventoryRecord[]> {
    return Promise.resolve([...this.runtimes.values()]);
  }
}

class FixedClock implements Clock {
  private tick = 0;

  now(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 6, 2, 0, 0, this.tick));
  }

  isoNow(): string {
    return this.now().toISOString();
  }
}

class FixedIds implements IdGenerator {
  private next = 0;

  sessionId() { return asId<"SessionId">("session-test"); }
  chatId() { return asId<"ChatId">("chat-test"); }
  runtimeId() { return asId<"RuntimeId">("runtime-test"); }
  runtimeGenerationId() { return asId<"RuntimeGenerationId">("generation-test"); }
  agentId() { return asId<"AgentId">("agent-test"); }
  runId() {
    this.next += 1;
    return asId<"RunId">(`run-${String(this.next)}`);
  }
  mountId() { return asId<"MountId">("mount-test"); }
  eventId() {
    this.next += 1;
    return asId<"EventId">(`event-${String(this.next)}`);
  }
  projectId() { return asId<"ProjectId">("project-test"); }
  workspaceSetId() { return asId<"WorkspaceSetId">("workspace-set-test"); }
  accessRequestId() { return asId<"AccessRequestId">("access-request-test"); }
  agentQuestionId() { return asId<"AgentQuestionId">("question-fixed"); }
  baselineId() { return asId<"BaselineId">("baseline-test"); }
  reviewSessionId() { return asId<"ReviewSessionId">("review-test"); }
  reviewCommentId() {
    this.next += 1;
    return asId<"ReviewCommentId">(`comment-${String(this.next)}`);
  }
  taskId() { return asId<"TaskId">("task-test"); }
  memoryCandidateId() { return asId<"MemoryCandidateId">("memory-test"); }
}

class NullLogger implements Logger {
  info(_message: string, _metadata?: JsonObject): void {}
  warn(_message: string, _metadata?: JsonObject): void {}
  error(_message: string, _metadata?: JsonObject): void {}
}

function commandResult(exitCode: number): CommandResult {
  return {
    command: "fake",
    args: [],
    cwd: "C:\\tmp",
    exitCode,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    durationMs: 1
  };
}
