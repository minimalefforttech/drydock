import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type CommandResult, type CommandRunner, type RuntimeHandle, type StartRuntimeRequest } from "@drydock/contracts";
import { MemoryLogger } from "@drydock/core";
import { DockerSandboxRuntimeAdapter } from "./dockerSandboxRuntimeAdapter.js";

test("a failed network-policy grant force-removes the newly created sandbox", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command, args, options): Promise<CommandResult> {
      calls.push([...args]);
      const failed = args[0] === "policy" && args[1] === "allow";
      return {
        command,
        args,
        cwd: options.cwd,
        exitCode: failed ? 1 : 0,
        signal: null,
        stdout: "",
        stderr: failed ? "policy denied" : "",
        durationMs: 1,
        timedOut: false
      };
    }
  };
  const adapter = new DockerSandboxRuntimeAdapter({
    sbxPath: "C:\\fixed\\sbx.exe",
    commandRunner: runner,
    cwd: "C:\\drydock",
    logger: new MemoryLogger()
  });
  const request: StartRuntimeRequest = {
    sessionId: asId<"SessionId">("session-1"),
    chatId: asId<"ChatId">("chat-1"),
    agentId: asId<"AgentId">("agent-1"),
    agentRole: "worker",
    workspacePath: "C:\\drydock\\workspace",
    generationId: asId<"RuntimeGenerationId">("generation-1"),
    runtimeId: asId<"RuntimeId">("runtime-1"),
    template: {
      id: "template-1",
      type: "docker-sandbox",
      network: "allowed",
      mounts: [],
      environment: {},
      adapterProviderIds: ["codex"],
      advancedOptions: { sandboxAgent: "codex", networkResources: "api.example.invalid" }
    }
  };

  await assert.rejects(adapter.createRuntime(request, "drydock-session-1"), /network allow failed: policy denied/);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ["create", "--name", "drydock-session-1"],
    ["policy", "allow", "network"],
    ["rm", "--force", "drydock-session-1"]
  ]);
});

test("a successful network-policy grant returns the resources string on the handle for durable persistence", async () => {
  const runner: CommandRunner = {
    async run(command, args, options): Promise<CommandResult> {
      return {
        command,
        args,
        cwd: options.cwd,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false
      };
    }
  };
  const adapter = new DockerSandboxRuntimeAdapter({
    sbxPath: "sbx",
    commandRunner: runner,
    cwd: "/drydock",
    logger: new MemoryLogger()
  });
  const request: StartRuntimeRequest = {
    sessionId: asId<"SessionId">("session-2"),
    chatId: asId<"ChatId">("chat-2"),
    agentId: asId<"AgentId">("agent-2"),
    agentRole: "worker",
    workspacePath: "/workspace",
    generationId: asId<"RuntimeGenerationId">("generation-2"),
    runtimeId: asId<"RuntimeId">("runtime-2"),
    template: {
      id: "template-2",
      type: "docker-sandbox",
      network: "allowed",
      mounts: [],
      environment: {},
      adapterProviderIds: ["codex"],
      advancedOptions: { sandboxAgent: "codex", networkResources: "api.example.invalid" }
    }
  };

  const handle = await adapter.createRuntime(request, "drydock-session-2");

  // RuntimeLifecycleService persists this into the inventory record's
  // metadata; without it surviving on the handle there is nothing to persist.
  assert.equal(handle.networkAllowResources, "api.example.invalid");
});

test("removeRuntime falls back to a handle-carried network-allow resource when the in-process policy map is empty (post-restart cleanup)", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command, args, options): Promise<CommandResult> {
      calls.push([...args]);
      return {
        command,
        args,
        cwd: options.cwd,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false
      };
    }
  };
  // A freshly constructed adapter never ran createRuntime for this handle, so
  // its in-process networkPolicies Map is empty - exactly the state after a
  // host/extension restart. The resources value below stands in for what
  // RuntimeCleanupService rebuilds from the persisted inventory record's
  // metadata (dockerSandboxRuntimeAdapter has no other way to learn it).
  const adapter = new DockerSandboxRuntimeAdapter({
    sbxPath: "sbx",
    commandRunner: runner,
    cwd: "/drydock",
    logger: new MemoryLogger()
  });
  const handle: RuntimeHandle = {
    runtimeId: asId<"RuntimeId">("runtime-restart"),
    runtimeGenerationId: asId<"RuntimeGenerationId">("generation-restart"),
    sessionId: asId<"SessionId">("session-restart"),
    adapter: "docker-sandbox",
    externalName: "drydock-restart-worker",
    workspacePath: "/workspace",
    mounts: [],
    status: "running",
    networkAllowResources: "api.example.invalid"
  };

  const result = await adapter.removeRuntime(handle, true);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    ["policy", "rm", "network", "--sandbox", "drydock-restart-worker", "--resource", "api.example.invalid"],
    ["rm", "--force", "drydock-restart-worker"]
  ]);
});

test("workspace mounts dedupe Windows drive and UNC aliases on every runner OS", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(command, args, options): Promise<CommandResult> {
      calls.push([...args]);
      return Promise.resolve({
        command,
        args,
        cwd: options.cwd,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false
      });
    }
  };
  const adapter = new DockerSandboxRuntimeAdapter({
    sbxPath: "sbx",
    commandRunner: runner,
    cwd: "/drydock",
    logger: new MemoryLogger()
  });
  const request = (workspacePath: string, mountPath: string, suffix: string): StartRuntimeRequest => ({
    sessionId: asId<"SessionId">(`session-${suffix}`),
    chatId: asId<"ChatId">(`chat-${suffix}`),
    agentId: asId<"AgentId">(`agent-${suffix}`),
    agentRole: "worker",
    workspacePath,
    generationId: asId<"RuntimeGenerationId">(`generation-${suffix}`),
    runtimeId: asId<"RuntimeId">(`runtime-${suffix}`),
    template: {
      id: `template-${suffix}`,
      type: "docker-sandbox",
      network: "disabled",
      mounts: [{
        mountId: asId<"MountId">(`mount-${suffix}`),
        hostPath: mountPath,
        runtimePath: "/workspace",
        mode: "read-write",
        source: "workspace-root"
      }],
      environment: {},
      adapterProviderIds: ["codex"],
      advancedOptions: { sandboxAgent: "codex" }
    }
  });

  await adapter.createRuntime(request("C:\\Studio\\Work", "c:/studio/work/", "drive"), "drive-runtime");
  await adapter.createRuntime(request("\\\\Server\\Share\\Work", "\\\\server\\share\\work\\", "unc"), "unc-runtime");

  assert.deepEqual(calls, [
    ["create", "--name", "drive-runtime", "codex", "C:\\Studio\\Work"],
    ["create", "--name", "unc-runtime", "codex", "\\\\Server\\Share\\Work"]
  ]);
});
