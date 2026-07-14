import { strict as assert } from "node:assert";
import test from "node:test";
import { asId, type CommandResult, type CommandRunner, type StartRuntimeRequest } from "@drydock/contracts";
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
