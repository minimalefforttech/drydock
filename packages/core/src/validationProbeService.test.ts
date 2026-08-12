/**
 * Probe-suite tests (ADR 0022, M6). The suite exists to answer "what happens
 * when agent-generated code tries", so these tests are mostly about the two
 * ways that answer can go wrong:
 *
 * - a must-fail probe that SUCCEEDS must raise an incident (quarantine, both
 *   bus events, no green stamp) - edge case E5, ux-flows F5;
 * - anything the product could not establish - no exec channel, no settings, an
 *   unreadable reply, a thrown channel - must read as `unknown`, never as a
 *   pass (edge case G2, ADR 0021's never-invent-green rule).
 *
 * Guest scripts are asserted to stay fixed literals with parameters travelling
 * as stdin JSON: a probe that could be talked into running something else would
 * be the hole it exists to find.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  asId,
  type CommandResult,
  type JsonObject,
  type NamedRuntimeConfig,
  type ValidationRuntimeId
} from "@drydock/contracts";
import { ProductEventBus, type ProductBusEvent } from "./eventBus.js";
import type { Logger } from "./logger.js";
import {
  EGRESS_GUEST_SCRIPT,
  MIRROR_WRITE_GUEST_SCRIPT,
  PRODUCTION_READ_GUEST_SCRIPT,
  ValidationProbeService,
  type ProbeResult,
  type ValidationProbeConfig,
  type ValidationProbeExec
} from "./validationProbeService.js";

const PRODUCTION_PATH = "\\\\therock\\Floats\\Projects";
const MIRROR_ROOT = "X:\\";
const MIRROR_PROBE_FILE = ".drydock-probe-write-check.tmp";
const CANARY_ARGV = ["rez", "env", "fr_core", "--", "python", "-c", "print('ok')"];

const CONFIG: ValidationProbeConfig = {
  productionUncPath: PRODUCTION_PATH,
  mirrorDriveRoot: MIRROR_ROOT,
  disallowedEgress: [
    { host: "therock", port: 445 },
    { host: "therock", port: 139 }
  ],
  toolsetResolveArgv: CANARY_ARGV
};

const RUNTIME: NamedRuntimeConfig = {
  runtimeId: asId<"ValidationRuntimeId">("rt-default"),
  displayName: "default",
  image: "win11-dcc-2026.03",
  lifecycle: "keep-warm",
  capabilities: ["maya", "houdini"],
  policyProfileRef: "validation_default",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

// ---------------------------------------------------------------------------
// The isolated guest: every forbidden attempt refused, canary green.
// ---------------------------------------------------------------------------

function refusedReplies(): Record<string, GuestReply> {
  return {
    "probe.production-read": {
      json: { path: PRODUCTION_PATH, exists: false, listed: false, entries: 0, error: "The network path was not found." }
    },
    "probe.mirror-write": {
      json: {
        target: `${MIRROR_ROOT}${MIRROR_PROBE_FILE}`,
        wrote: false,
        removed: false,
        error: "Access to the path is denied."
      }
    },
    "probe.egress": {
      json: {
        endpoints: [
          { address: "therock", port: 445, connected: false, error: "connect timed out" },
          { address: "therock", port: 139, connected: false, error: "connect timed out" }
        ]
      }
    },
    "probe.toolset-resolve": { stdout: "ok\n" }
  };
}

test("a refused guest makes every must-fail probe pass and stamps the run green", async () => {
  const h = harness();

  const run = await h.service.runProbes(RUNTIME);

  assert.deepEqual(run.probes.map((probe) => probe.probeId), [
    "probe.production-read",
    "probe.mirror-write",
    "probe.egress",
    "probe.toolset-resolve"
  ]);
  assert.deepEqual(run.probes.map((probe) => probe.state), ["pass", "pass", "pass", "pass"]);
  assert.equal(run.greenAt, "2026-08-12T09:00:00.000Z");
  assert.equal(run.breach, undefined);
  assert.equal(h.quarantined.length, 0);
  assert.deepEqual(h.events, []);

  // Details speak studio paths, and a pass says what was refused.
  assert.match(detail(run, "probe.production-read"), /not reachable from the validation runtime/);
  assert.ok(detail(run, "probe.production-read").includes(PRODUCTION_PATH));
  assert.ok(detail(run, "probe.production-read").includes("The network path was not found."));
  assert.match(detail(run, "probe.mirror-write"), /refuses writes from the validation runtime/);
  assert.equal(detail(run, "probe.egress"), "No connection to 2 blocked endpoints (therock:445, therock:139).");
});

test("a production read that succeeds quarantines the runtime and raises the incident", async () => {
  const h = harness();
  h.replies["probe.production-read"] = {
    json: { path: PRODUCTION_PATH, exists: true, listed: true, entries: 34, error: "" }
  };

  const run = await h.service.runProbes(RUNTIME);

  const probe = find(run, "probe.production-read");
  assert.equal(probe.state, "breach");
  assert.equal(probe.kind, "must-fail");
  assert.equal(probe.detail, `PRODUCTION READ SUCCEEDED: listed 34 entries under ${PRODUCTION_PATH}.`);
  assert.equal(run.greenAt, undefined);
  assert.deepEqual(run.breach, { probeId: "probe.production-read", detail: probe.detail });

  // Quarantine is applied before the incident is announced.
  assert.deepEqual(h.quarantined, [
    { runtimeId: "rt-default", probeId: "probe.production-read", detail: probe.detail }
  ]);
  assert.deepEqual(h.events, [
    {
      kind: "validation-quarantine",
      runtimeId: RUNTIME.runtimeId,
      probeId: "probe.production-read",
      detail: probe.detail,
      at: "2026-08-12T09:00:00.000Z"
    },
    { kind: "validation-runtime-changed" }
  ]);

  // The whole suite still ran: an incident log that stops at the first finding
  // hides the rest of the picture.
  assert.equal(run.probes.length, 4);
});

test("a production path that merely resolves is a breach, not a pass", async () => {
  const h = harness();
  h.replies["probe.production-read"] = {
    json: { path: PRODUCTION_PATH, exists: true, listed: false, entries: 0, error: "Access is denied." }
  };

  const run = await h.service.runProbes(RUNTIME);

  const probe = find(run, "probe.production-read");
  assert.equal(probe.state, "breach");
  assert.match(probe.detail, /PRODUCTION IS VISIBLE/);
  assert.equal(h.quarantined.length, 1);
});

test("a mirror write that succeeds is a breach and reports leftover litter", async () => {
  const h = harness();
  h.replies["probe.mirror-write"] = {
    json: { target: `${MIRROR_ROOT}${MIRROR_PROBE_FILE}`, wrote: true, removed: false, error: "" }
  };

  const run = await h.service.runProbes(RUNTIME);

  const probe = find(run, "probe.mirror-write");
  assert.equal(probe.state, "breach");
  assert.equal(
    probe.detail,
    `MIRROR WRITE SUCCEEDED: created ${MIRROR_ROOT}${MIRROR_PROBE_FILE} on the read-only package mirror and could not remove it again.`
  );
  assert.deepEqual(h.quarantined.map((call) => call.probeId), ["probe.mirror-write"]);
});

test("one connected endpoint breaches and names the host:port that answered", async () => {
  const h = harness();
  h.replies["probe.egress"] = {
    json: {
      endpoints: [
        { address: "therock", port: 445, connected: false, error: "connect timed out" },
        { address: "therock", port: 139, connected: true, error: "" }
      ]
    }
  };

  const run = await h.service.runProbes(RUNTIME);

  const probe = find(run, "probe.egress");
  assert.equal(probe.state, "breach");
  assert.equal(
    probe.detail,
    "EGRESS SUCCEEDED: the validation runtime connected to therock:139, which is outside the allowlist."
  );
  assert.equal(h.events.length, 2);
});

test("the toolset canary passes on exit 0 and fails - without quarantine - on anything else", async () => {
  const green = harness();
  const greenRun = await green.service.runProbes(RUNTIME);
  assert.equal(find(greenRun, "probe.toolset-resolve").state, "pass");

  const broken = harness();
  broken.replies["probe.toolset-resolve"] = {
    exitCode: 1,
    stderr: "rez: package family not found: fr_core\n"
  };

  const run = await broken.service.runProbes(RUNTIME);

  const probe = find(run, "probe.toolset-resolve");
  assert.equal(probe.kind, "must-succeed");
  assert.equal(probe.state, "fail");
  assert.equal(
    probe.detail,
    "The validation toolset canary failed (exit 1): rez: package family not found: fr_core"
  );
  // A broken canary blocks jobs; it is not a security incident.
  assert.equal(broken.quarantined.length, 0);
  assert.deepEqual(broken.events, []);
  assert.equal(run.greenAt, undefined);
});

test("no exec channel makes every probe unknown, with no incident", async () => {
  const h = harness({ noExec: true });

  const run = await h.service.runProbes(RUNTIME);

  assert.deepEqual(run.probes.map((probe) => probe.state), ["unknown", "unknown", "unknown", "unknown"]);
  assert.equal(run.greenAt, undefined);
  assert.equal(run.breach, undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(h.quarantined.length, 0);
  assert.deepEqual(h.events, []);
  assert.equal(
    detail(run, "probe.production-read"),
    "Not checked: default has no exec channel from this host right now."
  );
});

test("unconfigured probe settings make every probe unknown", async () => {
  const h = harness({ unconfigured: true });

  const run = await h.service.runProbes(RUNTIME);

  assert.deepEqual(run.probes.map((probe) => probe.state), ["unknown", "unknown", "unknown", "unknown"]);
  assert.equal(h.calls.length, 0);
  assert.equal(
    detail(run, "probe.egress"),
    "Not checked: validation probe settings are not configured for this workstation."
  );
});

test("an unreadable guest reply is unknown, never a pass", async () => {
  const h = harness();
  h.replies["probe.production-read"] = { stdout: "The term 'ConvertFrom-Json' is not recognized", exitCode: 1 };

  const run = await h.service.runProbes(RUNTIME);

  const probe = find(run, "probe.production-read");
  assert.equal(probe.state, "unknown");
  assert.match(probe.detail, /^Not checked: the guest check returned exit 1/);
  assert.equal(run.greenAt, undefined);
  assert.equal(h.quarantined.length, 0);
});

test("an exec channel that throws is unknown, not a refusal", async () => {
  const h = harness();
  h.replies["probe.mirror-write"] = { throws: new Error("ssh: connect to host 10.0.0.8 port 22: Connection refused") };

  const run = await h.service.runProbes(RUNTIME);

  const probe = find(run, "probe.mirror-write");
  assert.equal(probe.state, "unknown");
  assert.match(probe.detail, /^Not checked: the exec channel failed \(ssh: connect to host/);
  // The rest of the suite still ran.
  assert.equal(find(run, "probe.egress").state, "pass");
});

test("probesGreenAt serves the latest run only - a breach stops the last green from counting", async () => {
  const h = harness();

  await h.service.runProbes(RUNTIME);
  assert.equal(h.service.probesGreenAt(RUNTIME.runtimeId), "2026-08-12T09:00:00.000Z");

  h.setNow("2026-08-12T10:00:00.000Z");
  h.replies["probe.egress"] = {
    json: { endpoints: [{ address: "therock", port: 445, connected: true, error: "" }] }
  };
  const breached = await h.service.runProbes(RUNTIME);

  assert.equal(breached.greenAt, undefined);
  assert.equal(h.service.probesGreenAt(RUNTIME.runtimeId), undefined);
  assert.equal(h.service.lastResult(RUNTIME.runtimeId)?.at, "2026-08-12T10:00:00.000Z");
  // Nothing recorded for a runtime this process has never probed.
  assert.equal(h.service.probesGreenAt(asId<"ValidationRuntimeId">("rt-other")), undefined);
});

test("parameters travel as stdin JSON and never enter the script text", async () => {
  const h = harness();

  await h.service.runProbes(RUNTIME);

  const production = call(h, PRODUCTION_READ_GUEST_SCRIPT);
  const mirror = call(h, MIRROR_WRITE_GUEST_SCRIPT);
  const egress = call(h, EGRESS_GUEST_SCRIPT);

  assert.deepEqual(JSON.parse(production.input ?? ""), { path: PRODUCTION_PATH });
  assert.deepEqual(JSON.parse(mirror.input ?? ""), { root: MIRROR_ROOT, fileName: MIRROR_PROBE_FILE });
  assert.deepEqual(JSON.parse(egress.input ?? ""), {
    timeoutMs: 3000,
    endpoints: [
      { address: "therock", port: 445 },
      { address: "therock", port: 139 }
    ]
  });

  for (const guest of [production, mirror, egress]) {
    assert.deepEqual(guest.args.slice(0, 4), ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
    const script = guest.args[4] ?? "";
    assert.ok(script.includes("[Console]::In.ReadToEnd() | ConvertFrom-Json"));
    // Zero interpolation: no parameter value appears anywhere in the script.
    assert.ok(!script.includes(PRODUCTION_PATH));
    assert.ok(!script.includes(MIRROR_ROOT));
    assert.ok(!script.includes("therock"));
  }
});

test("the toolset canary argv runs verbatim, with no guest wrapper", async () => {
  const h = harness();

  await h.service.runProbes(RUNTIME);

  const canary = h.calls.find((entry) => entry.args[0] === "rez");
  assert.ok(canary !== undefined);
  assert.deepEqual(canary.args, CANARY_ARGV);
  assert.equal(canary.input, undefined);
  assert.equal(canary.timeoutMs, 20_000);
});

test("an unconfigured canary is unknown and blocks the green stamp", async () => {
  const h = harness({
    config: {
      productionUncPath: PRODUCTION_PATH,
      mirrorDriveRoot: MIRROR_ROOT,
      disallowedEgress: CONFIG.disallowedEgress
    }
  });

  const run = await h.service.runProbes(RUNTIME);

  assert.deepEqual(run.probes.map((probe) => probe.state), ["pass", "pass", "pass", "unknown"]);
  assert.equal(
    detail(run, "probe.toolset-resolve"),
    "Not checked: no validation toolset canary is configured for this runtime."
  );
  // Three passes and one unknown is not green (edge case G2).
  assert.equal(run.greenAt, undefined);
});

test("an empty blocked-endpoint list is unknown rather than a silent pass", async () => {
  const h = harness({
    config: { ...CONFIG, disallowedEgress: [] }
  });

  const run = await h.service.runProbes(RUNTIME);

  const probe = find(run, "probe.egress");
  assert.equal(probe.state, "unknown");
  assert.equal(probe.detail, "Not checked: no blocked endpoints are configured for this workstation.");
});

test("a long endpoint list raises the exec budget above the default", async () => {
  const endpoints = Array.from({ length: 8 }, (_value, index) => ({ host: "therock", port: 400 + index }));
  const h = harness({ config: { ...CONFIG, disallowedEgress: endpoints } });
  h.replies["probe.egress"] = {
    json: { endpoints: endpoints.map((endpoint) => ({ address: endpoint.host, port: endpoint.port, connected: false, error: "connect timed out" })) }
  };

  const run = await h.service.runProbes(RUNTIME);

  // 8 dials x 3 s plus 5 s of slack beats the 20 s default.
  assert.equal(call(h, EGRESS_GUEST_SCRIPT).timeoutMs, 29_000);
  assert.equal(find(run, "probe.egress").detail, "No connection to 8 blocked endpoints (therock:400, therock:401, therock:402, +5 more).");
});

test("a quarantine callback that throws still announces the incident", async () => {
  const h = harness({ quarantineError: new Error("inventory write failed") });
  h.replies["probe.mirror-write"] = {
    json: { target: `${MIRROR_ROOT}${MIRROR_PROBE_FILE}`, wrote: true, removed: true, error: "" }
  };

  const run = await h.service.runProbes(RUNTIME);

  assert.equal(run.breach?.probeId, "probe.mirror-write");
  assert.deepEqual(h.events.map((event) => event.kind), ["validation-quarantine", "validation-runtime-changed"]);
});

test("shouldRun probes an unseen runtime immediately, then honours the cadence", async () => {
  const h = harness();
  const cadence = 60 * 60 * 1000;

  assert.equal(h.service.shouldRun(RUNTIME.runtimeId, cadence, "2026-08-12T09:00:00.000Z"), true);

  await h.service.runProbes(RUNTIME); // stamped 09:00

  assert.equal(h.service.shouldRun(RUNTIME.runtimeId, cadence, "2026-08-12T09:30:00.000Z"), false);
  assert.equal(h.service.shouldRun(RUNTIME.runtimeId, cadence, "2026-08-12T10:00:00.000Z"), true);
  assert.equal(h.service.shouldRun(RUNTIME.runtimeId, cadence, "2026-08-12T11:00:00.000Z"), true);
  // Another runtime has never run here.
  assert.equal(h.service.shouldRun(asId<"ValidationRuntimeId">("rt-cpp"), cadence, "2026-08-12T09:00:01.000Z"), true);
  // An unreadable stamp probes rather than skips.
  assert.equal(h.service.shouldRun(RUNTIME.runtimeId, cadence, "not-a-timestamp"), true);
  // The default `now` comes from the clock, which is still on the last run.
  assert.equal(h.service.shouldRun(RUNTIME.runtimeId, cadence), false);
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ExecCall {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly input: string | undefined;
}

interface GuestReply {
  /** Guest JSON reply, serialized onto stdout. */
  readonly json?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly throws?: Error;
}

interface QuarantineCall {
  readonly runtimeId: string;
  readonly probeId: string;
  readonly detail: string;
}

interface Harness {
  readonly service: ValidationProbeService;
  readonly replies: Record<string, GuestReply>;
  readonly calls: ExecCall[];
  readonly events: ProductBusEvent[];
  readonly quarantined: QuarantineCall[];
  setNow(value: string): void;
}

function harness(options: {
  readonly noExec?: boolean;
  readonly unconfigured?: boolean;
  readonly config?: ValidationProbeConfig;
  readonly quarantineError?: Error;
} = {}): Harness {
  const replies = refusedReplies();
  const calls: ExecCall[] = [];
  const events: ProductBusEvent[] = [];
  const quarantined: QuarantineCall[] = [];
  const bus = new ProductEventBus();
  bus.subscribe((event) => {
    events.push(event);
  });
  let now = "2026-08-12T09:00:00.000Z";

  const exec: ValidationProbeExec = (args, timeoutMs, input) => {
    calls.push({ args, timeoutMs, input });
    const reply = replies[probeOf(args)] ?? {};
    if (reply.throws !== undefined) return Promise.reject(reply.throws);
    return Promise.resolve({
      command: "ssh",
      args,
      cwd: ".",
      exitCode: reply.exitCode ?? 0,
      signal: null,
      stdout: reply.stdout ?? (reply.json === undefined ? "" : JSON.stringify(reply.json)),
      stderr: reply.stderr ?? "",
      durationMs: 12,
      timedOut: reply.timedOut ?? false
    } satisfies CommandResult);
  };

  const service = new ValidationProbeService({
    clock: { isoNow: () => now },
    logger: new NullLogger(),
    bus,
    execFor: () => (options.noExec === true ? null : exec),
    config: () => (options.unconfigured === true ? undefined : options.config ?? CONFIG),
    quarantine: (runtimeId: ValidationRuntimeId, probeId: string, detail: string) => {
      quarantined.push({ runtimeId, probeId, detail });
      return options.quarantineError === undefined ? Promise.resolve() : Promise.reject(options.quarantineError);
    }
  });

  return {
    service,
    replies,
    calls,
    events,
    quarantined,
    setNow: (value: string) => {
      now = value;
    }
  };
}

/** Which probe an exec call belongs to, read from its argv. */
function probeOf(args: readonly string[]): string {
  const script = args[4] ?? "";
  if (script === PRODUCTION_READ_GUEST_SCRIPT) return "probe.production-read";
  if (script === MIRROR_WRITE_GUEST_SCRIPT) return "probe.mirror-write";
  if (script === EGRESS_GUEST_SCRIPT) return "probe.egress";
  return "probe.toolset-resolve";
}

function call(h: Harness, script: string): ExecCall {
  const entry = h.calls.find((candidate) => candidate.args[4] === script);
  assert.ok(entry !== undefined, "expected an exec call for the guest script");
  return entry;
}

function find(run: { readonly probes: readonly ProbeResult[] }, probeId: string): ProbeResult {
  const probe = run.probes.find((candidate) => candidate.probeId === probeId);
  assert.ok(probe !== undefined, `expected a result for ${probeId}`);
  return probe;
}

function detail(run: { readonly probes: readonly ProbeResult[] }, probeId: string): string {
  return find(run, probeId).detail;
}

class NullLogger implements Logger {
  info(_message: string, _metadata?: JsonObject): void {}
  warn(_message: string, _metadata?: JsonObject): void {}
  error(_message: string, _metadata?: JsonObject): void {}
}
