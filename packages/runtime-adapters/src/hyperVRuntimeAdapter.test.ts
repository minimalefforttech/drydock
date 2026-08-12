/**
 * Hyper-V validation runtime adapter tests (ADR 0022 M3).
 *
 * Three invariants carry most of the weight here:
 * - adopt-only: the happy path starts and waits, and NO test ever sees
 *   `Remove-VM` in any script the adapter runs;
 * - the exec channel's option set is exact, because host-key policy and
 *   BatchMode are what make the channel trustworthy;
 * - guest parameters travel as stdin JSON, never as script text.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  asId,
  type CommandResult,
  type CommandRunner,
  type CommandRunnerOptions,
  type RuntimeHandle,
  type StartRuntimeRequest
} from "@drydock/contracts";
import { MemoryLogger } from "@drydock/core";
import { guestJsonCommand, HyperVRuntimeAdapter, type HyperVRuntimeAdapterOptions } from "./hyperVRuntimeAdapter.js";

const SSH_PATH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const KNOWN_HOSTS = "C:\\drydock\\state\\hyperv_known_hosts";
const VM_NAME = "drydock-validate-a";

interface Recorded {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: CommandRunnerOptions;
}

function recordingRunner(reply: (call: Recorded) => Partial<CommandResult>): {
  readonly runner: CommandRunner;
  readonly calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const runner: CommandRunner = {
    run(command, args, options): Promise<CommandResult> {
      const call: Recorded = { command, args: [...args], options };
      calls.push(call);
      return Promise.resolve({
        command,
        args,
        cwd: options.cwd,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        ...reply(call)
      });
    }
  };
  return { runner, calls };
}

/** A fake clock the adapter's own sleep advances, so polling never really waits. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: (ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    }
  };
}

function makeAdapter(runner: CommandRunner, overrides: Partial<HyperVRuntimeAdapterOptions> = {}): HyperVRuntimeAdapter {
  const clock = fakeClock();
  return new HyperVRuntimeAdapter({
    sshPath: SSH_PATH,
    powershellPath: POWERSHELL_PATH,
    commandRunner: runner,
    cwd: "C:\\drydock",
    logger: new MemoryLogger(),
    connection: { host: "10.10.0.5", user: "validator" },
    knownHostsFile: KNOWN_HOSTS,
    adoptTimeoutMs: 6_000,
    environment: { PATH: "C:\\Windows\\System32" },
    now: clock.now,
    sleep: clock.sleep,
    ...overrides
  });
}

function startRequest(): StartRuntimeRequest {
  return {
    sessionId: asId<"SessionId">("session-1"),
    chatId: asId<"ChatId">("chat-1"),
    agentId: asId<"AgentId">("agent-1"),
    agentRole: "tester",
    workspacePath: "C:\\drydock\\workspace",
    generationId: asId<"RuntimeGenerationId">("generation-1"),
    runtimeId: asId<"RuntimeId">("runtime-1"),
    template: {
      id: "template-validation",
      type: "hyperv",
      network: "disabled",
      mounts: [],
      environment: {},
      adapterProviderIds: [],
      advancedOptions: {}
    }
  };
}

function handle(): RuntimeHandle {
  return {
    runtimeId: asId<"RuntimeId">("runtime-1"),
    runtimeGenerationId: asId<"RuntimeGenerationId">("generation-1"),
    sessionId: asId<"SessionId">("session-1"),
    adapter: "hyperv",
    externalName: VM_NAME,
    workspacePath: "C:\\drydock\\workspace",
    runtimeCwd: "C:\\drydock\\jobs",
    mounts: [],
    status: "running"
  };
}

function vmJson(state: number): string {
  return JSON.stringify([{ Name: VM_NAME, State: state, CPUUsage: 4, MemoryAssigned: 2048, UptimeMs: 1000 }]);
}

const isListVms = (call: Recorded): boolean => String(call.args[3]).includes("Get-VM | Select-Object");

test("adopt starts an off VM, waits for Running, then proves the exec channel", async () => {
  let lists = 0;
  const { runner, calls } = recordingRunner((call) => {
    if (call.command === SSH_PATH) return {};
    if (isListVms(call)) {
      lists += 1;
      return { stdout: vmJson(lists === 1 ? 3 : 2) };
    }
    return {};
  });

  const adopted = await makeAdapter(runner).createRuntime(startRequest(), VM_NAME);

  assert.deepEqual(adopted, {
    runtimeId: asId<"RuntimeId">("runtime-1"),
    runtimeGenerationId: asId<"RuntimeGenerationId">("generation-1"),
    sessionId: asId<"SessionId">("session-1"),
    adapter: "hyperv",
    externalName: VM_NAME,
    workspacePath: "C:\\drydock\\workspace",
    runtimeCwd: "C:\\drydock\\jobs",
    mounts: [],
    status: "running"
  });
  // list -> Start-VM -> list -> ssh probe, and nothing else.
  assert.equal(calls.length, 4);
  assert.match(String(calls[1]?.args[3]), /Start-VM/);
  assert.equal(calls[1]?.options.env?.["DRYDOCK_VM_NAME"], VM_NAME);
  assert.equal(calls[3]?.command, SSH_PATH);
  assert.deepEqual(calls[3]?.args.slice(-5), ["--", "cmd", "/c", "exit", "0"]);
  for (const call of calls) {
    assert.equal(String(call.args[3]).includes("Remove-VM"), false);
  }
});

test("adopt skips Start-VM when the VM is already Running", async () => {
  const { runner, calls } = recordingRunner((call) =>
    call.command === SSH_PATH ? {} : { stdout: vmJson(2) }
  );

  await makeAdapter(runner).createRuntime(startRequest(), VM_NAME);

  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => String(call.args[3]).includes("Start-VM")), false);
});

test("adopt refuses to invent a VM that is not there", async () => {
  const { runner, calls } = recordingRunner(() => ({ stdout: "[]" }));

  await assert.rejects(
    makeAdapter(runner).createRuntime(startRequest(), VM_NAME),
    /unable to find a virtual machine named "drydock-validate-a" to adopt.*adopted, never created/s
  );
  assert.equal(calls.length, 1);
});

test("adopt reports an honest timeout naming the last observed state", async () => {
  const { runner } = recordingRunner((call) => (isListVms(call) ? { stdout: vmJson(9) } : {}));

  await assert.rejects(
    makeAdapter(runner).createRuntime(startRequest(), VM_NAME),
    /did not reach Running within 6000ms \(last observed state: other\(9\)\)/
  );
});

test("adopt fails honestly when the VM runs but the exec channel never answers", async () => {
  const { runner } = recordingRunner((call) =>
    call.command === SSH_PATH
      ? { exitCode: 255, stderr: "ssh: connect to host 10.10.0.5 port 22: Connection refused" }
      : { stdout: vmJson(2) }
  );

  await assert.rejects(
    makeAdapter(runner).createRuntime(startRequest(), VM_NAME),
    /exec channel did not answer within 6000ms \(validator@10\.10\.0\.5\): ssh: connect to host/
  );
});

test("stop asks for a graceful shutdown and remove DETACHES without ever deleting the VM", async () => {
  const { runner, calls } = recordingRunner(() => ({}));
  const adapter = makeAdapter(runner);

  const stopped = await adapter.stopRuntime(handle(), "cleanup");
  const detached = await adapter.removeRuntime(handle(), false);
  const forced = await adapter.removeRuntime(handle(), true);

  assert.equal(stopped.exitCode, 0);
  assert.equal(String(calls[0]?.args[3]).includes("-TurnOff"), false);
  assert.match(detached.stdout, /detached \(VM preserved\)/);
  assert.match(detached.stdout, /never deleted by the product/);
  assert.equal(detached.exitCode, 0);
  assert.match(String(calls[2]?.args[3]), /-TurnOff/);
  assert.equal(forced.exitCode, 0);
  // The whole point: no script this adapter runs can delete a VM.
  for (const call of calls) {
    assert.equal(String(call.args[3]).includes("Remove-VM"), false);
    assert.equal(call.options.env?.["DRYDOCK_VM_NAME"], VM_NAME);
  }
});

test("detach succeeds for an already-absent VM but surfaces a genuinely stuck one", async () => {
  const absent = recordingRunner(() => ({
    exitCode: 3,
    stderr: "Hyper-V was unable to find a virtual machine with the requested name."
  }));
  const detached = await makeAdapter(absent.runner).removeRuntime(handle(), true);
  assert.equal(detached.exitCode, 0);
  assert.match(detached.stdout, /already absent from Hyper-V; nothing was deleted/);

  const stuck = recordingRunner(() => ({ exitCode: 3, stderr: "The operation cannot be performed while the VM is saving." }));
  const failed = await makeAdapter(stuck.runner).removeRuntime(handle(), false);
  assert.equal(failed.exitCode, 3);
  assert.match(failed.stderr, /cannot be performed/);
});

test("detach does not mistake a still-present VM for absent when the failure merely mentions a virtual machine", async () => {
  // Contains "virtual machine" AND "was not found" - the OLD broad matcher
  // (`no virtual machine` / `virtual machine .* was not found`) would have called
  // this absent and stamped exit 0. It is a real stop failure: return it raw so
  // cleanup quarantines a VM that is still Running.
  const busy = recordingRunner(() => ({
    exitCode: 3,
    stderr: "Cannot stop the virtual machine 'drydock-validate-a' because a required resource was not found; access is denied."
  }));

  const failed = await makeAdapter(busy.runner).removeRuntime(handle(), true);

  assert.equal(failed.exitCode, 3);
  assert.match(failed.stderr, /access is denied/);
  assert.equal(failed.stdout.includes("already absent"), false);
});

test("an empty VM name is a clear error at the control plane, never a silent absent", async () => {
  const { runner, calls } = recordingRunner(() => ({}));
  const adapter = makeAdapter(runner);
  const namelessHandle: RuntimeHandle = { ...handle(), externalName: "   " };

  // removeRuntime must NOT rewrite a missing name into a synthetic "already
  // absent; nothing was deleted" - the guard rejects before any script runs.
  await assert.rejects(adapter.removeRuntime(namelessHandle, true), /VM name is required/);
  await assert.rejects(async () => adapter.control.stopVm("", false), /VM name is required/);
  assert.equal(calls.length, 0);
});

test("external names are token-extracted from the VM list, not trusted whole", async () => {
  const { runner } = recordingRunner(() => ({
    stdout: JSON.stringify([
      { Name: "drydock-session-1-worker", State: 2 },
      { Name: "  drydock-session-2-tester (copy)", State: 3 },
      { Name: "someone-elses-vm", State: 2 },
      { Name: "drydock-session-1-worker", State: 2 }
    ])
  }));

  const names = await makeAdapter(runner).listExternalRuntimeNames("drydock");

  assert.deepEqual(names, ["drydock-session-1-worker", "drydock-session-2-tester"]);
});

test("exec composes the exact ssh option set, with port and identity variants", async () => {
  const plain = recordingRunner(() => ({}));
  await makeAdapter(plain.runner).exec(handle(), ["rez", "env", "maya"], 5_000);
  assert.deepEqual(plain.calls[0]?.args, [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS}`,
    "validator@10.10.0.5",
    "--",
    "rez", "env", "maya"
  ]);
  assert.equal(plain.calls[0]?.command, SSH_PATH);
  assert.equal(plain.calls[0]?.options.timeoutMs, 5_000);
  // No multiplexing options: Windows OpenSSH has no ControlMaster.
  assert.equal(plain.calls[0]?.args.some((arg) => arg.startsWith("ControlM")), false);
  assert.equal(plain.calls[0]?.args.some((arg) => arg.startsWith("ControlP")), false);

  const full = recordingRunner(() => ({}));
  const adapter = makeAdapter(full.runner, {
    connection: { host: "10.10.0.5", port: 2222, user: "validator" },
    identityFile: "C:\\drydock\\state\\hyperv_ed25519"
  });
  await adapter.exec(handle(), ["-Command", "exit 0"], 5_000);
  assert.deepEqual(full.calls[0]?.args, [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS}`,
    "-i", "C:\\drydock\\state\\hyperv_ed25519",
    "-p", "2222",
    "validator@10.10.0.5",
    "--",
    // `--` is what keeps a leading-dash guest argument out of ssh's own parsing.
    "-Command", "exit 0"
  ]);
});

test("exec passes stdin, abort, and line streaming straight through to the runner", async () => {
  const lines: string[] = [];
  const controller = new AbortController();
  const { runner, calls } = recordingRunner((call) => {
    call.options.onStdoutLine?.("resolved maya-2026.1");
    call.options.onStdoutLine?.("12 passed");
    return { stdout: "resolved maya-2026.1\n12 passed\n" };
  });

  const result = await makeAdapter(runner).exec(
    handle(),
    ["cmd", "/c", "echo hi"],
    9_000,
    "stdin payload",
    controller.signal,
    (line) => lines.push(line)
  );

  assert.deepEqual(lines, ["resolved maya-2026.1", "12 passed"]);
  assert.equal(calls[0]?.options.input, "stdin payload");
  assert.equal(calls[0]?.options.signal, controller.signal);
  assert.equal(result.exitCode, 0);
});

test("guestJsonCommand is a fixed-literal powershell invocation for the guest", () => {
  const argv = guestJsonCommand("ConvertTo-Json -Compress -InputObject @{ ok = $true }");
  assert.deepEqual(argv, [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "ConvertTo-Json -Compress -InputObject @{ ok = $true }"
  ]);
});

test("sweepGuestJob sends the token as stdin JSON, walks the parent tree, and stops every PID", async () => {
  const { runner, calls } = recordingRunner(() => ({ stdout: JSON.stringify({ killed: [4321, 8765] }) }));

  const killed = await makeAdapter(runner).sweepGuestJob(handle(), "vjb-0f31a", 20_000);

  // parseKilledPids returns exactly the PID list the guest reported.
  assert.deepEqual(killed, [4321, 8765]);
  const args = calls[0]?.args ?? [];
  assert.deepEqual(args.slice(-5, -1), ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
  const script = String(args[args.length - 1]);
  assert.match(script, /\[Console\]::In\.ReadToEnd\(\) \| ConvertFrom-Json/);
  assert.equal(script.includes("vjb-0f31a"), false);
  // The token reaches the guest only as stdin JSON, never spliced into script text.
  assert.equal(calls[0]?.options.input, JSON.stringify({ jobToken: "vjb-0f31a" }));
  // The query is unfiltered and the token is compared at runtime in PowerShell.
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /-like \('\*' \+ \$token \+ '\*'\)/);
  // The hung DCC child carries no token, so the sweep walks the parent tree and
  // stops every descendant of each matched (token-carrying) wrapper process.
  assert.match(script, /ParentProcessId/);
  assert.match(script, /childrenByParent/);
  assert.match(script, /Stop-Process -Id \$target -Force/);
});

test("sweepGuestJob refuses a token that could widen the -like match, and reads a failure honestly", async () => {
  const { runner, calls } = recordingRunner(() => ({}));
  const adapter = makeAdapter(runner);

  await assert.rejects(adapter.sweepGuestJob(handle(), "vjb-*", 20_000), /Refusing to sweep with job token/);
  assert.equal(calls.length, 0);

  const failing = recordingRunner(() => ({ exitCode: 1, stderr: "Access is denied." }));
  await assert.rejects(
    makeAdapter(failing.runner).sweepGuestJob(handle(), "vjb-1", 20_000),
    /Guest job sweep failed for "drydock-validate-a": Access is denied/
  );
});
