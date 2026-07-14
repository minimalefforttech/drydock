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
