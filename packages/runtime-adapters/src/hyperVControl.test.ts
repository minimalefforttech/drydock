/**
 * Hyper-V control-plane tests (ADR 0022 M3).
 *
 * The invariant under test everywhere here is the fixed-literal rule: script
 * text is constant, and VM/checkpoint names reach PowerShell only as
 * environment variables. Every test that passes a name also asserts the name is
 * absent from the script argument.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import type { CommandResult, CommandRunner, CommandRunnerOptions } from "@drydock/contracts";
import { HyperVControl, mapVmState } from "./hyperVControl.js";

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

function control(runner: CommandRunner): HyperVControl {
  return new HyperVControl({
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    commandRunner: runner,
    cwd: "C:\\drydock",
    environment: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" }
  });
}

const TWO_VMS = JSON.stringify([
  { Name: "drydock-validate-a", State: 2, CPUUsage: 7, MemoryAssigned: 4294967296, UptimeMs: 61000 },
  { Name: "drydock-validate-b", State: 3, CPUUsage: 0, MemoryAssigned: 0, UptimeMs: 0 }
]);

test("listVms parses an array, maps numeric states, and never names a VM in script text", async () => {
  const { runner, calls } = recordingRunner(() => ({ stdout: TWO_VMS }));

  const vms = await control(runner).listVms();

  assert.deepEqual(vms, [
    { name: "drydock-validate-a", state: "running", cpuUsagePercent: 7, memoryAssignedBytes: 4294967296, uptimeMs: 61000 },
    { name: "drydock-validate-b", state: "off", cpuUsagePercent: 0, memoryAssignedBytes: 0, uptimeMs: 0 }
  ]);
  const call = calls[0];
  assert.equal(call?.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(call?.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  // Listing lists EVERYTHING: no name filter reaches the script.
  assert.equal(String(call?.args[3]).includes("drydock-validate"), false);
  assert.equal(String(call?.args[3]).includes("-Name "), false);
});

test("listVms accepts the single-object JSON PowerShell emits for one result", async () => {
  const { runner } = recordingRunner(() => ({
    stdout: JSON.stringify({ Name: "solo-vm", State: "Running", CPUUsage: 3, MemoryAssigned: 2048, UptimeMs: 10 })
  }));

  const vms = await control(runner).listVms();

  assert.equal(vms.length, 1);
  assert.equal(vms[0]?.name, "solo-vm");
  assert.equal(vms[0]?.state, "running");
});

test("listVms reads an empty host and a failed Get-VM honestly", async () => {
  const empty = recordingRunner(() => ({ stdout: "   " }));
  assert.deepEqual(await control(empty.runner).listVms(), []);

  const failed = recordingRunner(() => ({ exitCode: 1, stderr: "You do not have the required permission." }));
  await assert.rejects(control(failed.runner).listVms(), /Get-VM failed: You do not have the required permission/);
});

test("state mapping covers numbers, strings, and keeps unknown states visibly unknown", () => {
  assert.equal(mapVmState(2), "running");
  assert.equal(mapVmState(3), "off");
  assert.equal(mapVmState("Running"), "running");
  assert.equal(mapVmState("off"), "off");
  assert.equal(mapVmState("2"), "running");
  // Anything else keeps its raw value: an unknown state must never read healthy.
  assert.equal(mapVmState(9), "other(9)");
  assert.equal(mapVmState("Paused"), "other(Paused)");
  assert.equal(mapVmState(null), "other(unknown)");
});

test("getVm filters client-side and returns null for a name the host does not have", async () => {
  const { runner, calls } = recordingRunner(() => ({ stdout: TWO_VMS }));
  const subject = control(runner);

  assert.equal((await subject.getVm("drydock-validate-b"))?.state, "off");
  assert.equal(await subject.getVm("drydock-validate-z"), null);
  // A wildcard name is just a string that fails to match - it never reaches
  // PowerShell, so it cannot widen a `-Name` query.
  assert.equal(await subject.getVm("drydock-*"), null);
  for (const call of calls) {
    assert.equal(String(call.args[3]).includes("*"), false);
  }
});

test("VM and checkpoint names travel as environment variables over the base environment", async () => {
  const { runner, calls } = recordingRunner(() => ({}));
  const subject = control(runner);

  await subject.startVm("drydock-validate-a");
  await subject.checkpoint("drydock-validate-a", "clean-2026-08-12");
  await subject.restoreCheckpoint("drydock-validate-a", "clean-2026-08-12");

  for (const call of calls) {
    const script = String(call.args[3]);
    assert.equal(script.includes("drydock-validate-a"), false);
    assert.equal(script.includes("clean-2026-08-12"), false);
    assert.equal(call.options.env?.["DRYDOCK_VM_NAME"], "drydock-validate-a");
    // The base environment survives: replacing it outright would strip PATH.
    assert.equal(call.options.env?.["PATH"], "C:\\Windows\\System32");
  }
  assert.equal(calls[0]?.options.env?.["DRYDOCK_CHECKPOINT_NAME"], undefined);
  assert.equal(calls[1]?.options.env?.["DRYDOCK_CHECKPOINT_NAME"], "clean-2026-08-12");
  assert.equal(calls[2]?.options.env?.["DRYDOCK_CHECKPOINT_NAME"], "clean-2026-08-12");
  assert.match(String(calls[1]?.args[3]), /Checkpoint-VM/);
  assert.match(String(calls[2]?.args[3]), /Restore-VMSnapshot/);
});

test("stopVm picks the graceful script or the hard TurnOff one, and never removes a VM", async () => {
  const { runner, calls } = recordingRunner(() => ({}));
  const subject = control(runner);

  await subject.stopVm("drydock-validate-a", false);
  await subject.stopVm("drydock-validate-a", true);

  assert.match(String(calls[0]?.args[3]), /Stop-VM -VM \$found\[0\] -Force/);
  assert.equal(String(calls[0]?.args[3]).includes("-TurnOff"), false);
  assert.match(String(calls[1]?.args[3]), /Stop-VM -VM \$found\[0\] -TurnOff -Force/);
  for (const call of calls) {
    assert.equal(String(call.args[3]).includes("Remove-VM"), false);
  }
});

test("a mutating result comes back raw so cleanup can tell already-gone from stuck", async () => {
  const { runner } = recordingRunner(() => ({
    exitCode: 3,
    stderr: "Hyper-V was unable to find a virtual machine with the requested name."
  }));

  const result = await control(runner).stopVm("drydock-validate-ghost", false);

  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /unable to find a virtual machine/);
});

test("listCheckpoints filters to one VM, newest first, and counters roll up by prefix", async () => {
  const snapshots = JSON.stringify([
    { VMName: "drydock-validate-a", Name: "clean-1", SnapshotType: "Standard", CreationTime: "2026-08-10T09:00:00" },
    { VMName: "drydock-validate-a", Name: "clean-2", SnapshotType: "Standard", CreationTime: "2026-08-12T09:00:00" },
    { VMName: "other-vm", Name: "not-ours", SnapshotType: "Standard", CreationTime: "2026-08-11T09:00:00" }
  ]);
  const { runner, calls } = recordingRunner((call) => ({
    stdout: String(call.args[3]).includes("Get-VMSnapshot") ? snapshots : TWO_VMS
  }));
  const subject = control(runner);

  const checkpoints = await subject.listCheckpoints("drydock-validate-a");
  assert.deepEqual(checkpoints.map((entry) => entry.name), ["clean-2", "clean-1"]);
  assert.equal(String(calls[0]?.args[3]).includes("drydock-validate-a"), false);

  const counters = await subject.counters("drydock-");
  assert.deepEqual(counters, {
    total: 2,
    running: 1,
    off: 1,
    other: 0,
    memoryAssignedBytes: 4294967296,
    cpuUsagePercent: 7
  });
});
