import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  blocksGlobalMemoryBriefing,
  filterPolicyOverlayRoots,
  loadEffectiveSecurityPolicy,
  resolvePolicyOverlayFile,
  type UserSecurityPreferences
} from "./securityPolicy.js";

const unrestrictedUser: UserSecurityPreferences = {
  allowedProjectRoots: [],
  cloneOnly: false,
  omitSensitiveFiles: false,
  omittedRepoPaths: [],
  networkedAiEnabled: true
};

test("Studio and personal project allowlists intersect at the narrower root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const studioRoot = path.join(root, "shows");
    const permitted = path.join(studioRoot, "show-a");
    const blocked = path.join(studioRoot, "show-b");
    await Promise.all([mkdir(permitted, { recursive: true }), mkdir(blocked, { recursive: true })]);
    const policyPath = path.join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify({
      version: 1,
      policyId: "studio-test",
      allowedProjectRoots: [studioRoot]
    }), "utf8");

    const policy = loadEffectiveSecurityPolicy({
      studioPolicyPath: policyPath,
      baseDeniedPaths: [],
      user: { ...unrestrictedUser, allowedProjectRoots: [permitted] }
    });

    assert.equal(policy.managed, true);
    assert.deepEqual(policy.allowedProjectRoots, [permitted]);
    assert.equal(policy.assertHostPathAllowed(permitted), permitted);
    assert.throws(() => policy.assertHostPathAllowed(blocked), /outside the configured project allowlist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Studio restrictions can only tighten clone, omission, deny, and network policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const projects = path.join(root, "projects");
    const denied = path.join(projects, "studio-admin");
    const allowed = path.join(projects, "show-a");
    await Promise.all([mkdir(denied, { recursive: true }), mkdir(allowed, { recursive: true })]);
    const policyPath = path.join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify({
      version: 1,
      policyId: "locked",
      allowedProjectRoots: [projects],
      deniedPaths: [denied],
      cloneOnly: true,
      omitSensitiveFiles: true,
      omittedRepoPaths: ["config/local"],
      allowNetworkedAiOnThisMachine: false
    }), "utf8");

    const policy = loadEffectiveSecurityPolicy({
      studioPolicyPath: policyPath,
      baseDeniedPaths: [],
      user: unrestrictedUser
    });

    assert.equal(policy.cloneOnly, true);
    assert.equal(policy.cloneOmission.sensitive, true);
    assert.deepEqual(policy.cloneOmission.paths, ["config/local"]);
    assert.throws(() => policy.assertHostPathAllowed(denied), /intersects a denied path/);
    assert.throws(() => policy.assertNetworkedAiAllowed(), /studio-allocated AI workstation/);
    assert.match(policy.summary().label, /^Managed · Clone only/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production tier (ADR 0022) is studio data denials only, never credential defaults or sensitive files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-production-tier-"));
  try {
    const showData = path.join(root, "Projects");
    const credentials = path.join(root, "creds");
    await Promise.all([mkdir(showData, { recursive: true }), mkdir(credentials, { recursive: true })]);
    const policyPath = path.join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify({
      version: 1,
      policyId: "production-tier",
      deniedPaths: [showData]
    }), "utf8");

    const policy = loadEffectiveSecurityPolicy({
      studioPolicyPath: policyPath,
      // The credential dir arrives via the base denylist, exactly like the real
      // ~/.ssh defaults do - it is denied, but it must NOT be production-tier.
      baseDeniedPaths: [credentials],
      user: unrestrictedUser
    });

    // A studio-denied show-data file IS production-tier (snapshot-eligible).
    assert.equal(policy.isProductionPath(path.join(showData, "ShowA", "hero_rig.ma")), true);
    // A credential-default path is denied but NOT production-tier.
    assert.equal(policy.isProductionPath(path.join(credentials, "id_rsa")), false);
    // A sensitive file, even under the studio data root, is never production-tier.
    assert.equal(policy.isProductionPath(path.join(showData, "ShowA", "id_rsa")), false);
    assert.equal(policy.isProductionPath(path.join(showData, "ShowA", ".env")), false);
    // A path outside every denial is not production-tier.
    assert.equal(policy.isProductionPath(path.join(root, "elsewhere", "scene.ma")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unmanaged machine has no production tier, so the fixture flow is inert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-no-managed-"));
  try {
    const policy = loadEffectiveSecurityPolicy({
      studioPolicyPath: path.join(root, "absent-policy.json"),
      baseDeniedPaths: [path.join(root, "creds")],
      user: unrestrictedUser
    });
    assert.equal(policy.managed, false);
    assert.deepEqual([...policy.productionDataPaths], []);
    assert.equal(policy.isProductionPath(path.join(root, "creds", "id_rsa")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured denied paths reject relative entries and preserve foreign absolute syntax", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-denied-paths-"));
  try {
    const policyPath = path.join(root, "no-policy.json");
    assert.throws(() => loadEffectiveSecurityPolicy({
      studioPolicyPath: policyPath,
      baseDeniedPaths: ["relative/secrets"],
      user: unrestrictedUser
    }), /must use absolute paths/);

    if (process.platform !== "win32") {
      const policy = loadEffectiveSecurityPolicy({
        studioPolicyPath: policyPath,
        baseDeniedPaths: ["C:\\Studio\\Secrets", "\\\\server\\share\\restricted"],
        user: unrestrictedUser
      });
      assert.deepEqual(policy.deniedPaths, ["C:\\Studio\\Secrets", "\\\\server\\share\\restricted"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing denied leaf remains denied through a symlinked parent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-denied-link-"));
  try {
    const actualHome = path.join(root, "actual-home");
    const homeAlias = path.join(root, "home-alias");
    await mkdir(actualHome);
    try {
      await symlink(actualHome, homeAlias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("This account cannot create symbolic links or junctions.");
        return;
      }
      throw error;
    }

    const policy = loadEffectiveSecurityPolicy({
      studioPolicyPath: path.join(root, "no-policy.json"),
      baseDeniedPaths: [path.join(homeAlias, ".ssh")],
      user: unrestrictedUser
    });
    const sensitiveDirectory = path.join(actualHome, ".ssh");
    await mkdir(sensitiveDirectory);

    assert.throws(() => policy.assertHostPathAllowed(sensitiveDirectory), /intersects a denied path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Invalid Studio policy fails closed instead of falling back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const policyPath = path.join(root, "policy.json");
    await writeFile(policyPath, "{not-json", "utf8");
    assert.throws(
      () => loadEffectiveSecurityPolicy({ studioPolicyPath: policyPath, baseDeniedPaths: [], user: unrestrictedUser }),
      /unreadable or invalid JSON/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A required managed policy cannot silently fall back to personal settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const policyPath = path.join(root, "policy.json");
    const requiredPath = path.join(root, "policy.required");
    await writeFile(requiredPath, "managed\n", "utf8");
    assert.throws(
      () => loadEffectiveSecurityPolicy({
        studioPolicyPath: policyPath,
        studioPolicyRequiredPath: requiredPath,
        baseDeniedPaths: [],
        user: unrestrictedUser
      }),
      /required but missing/
    );
    assert.throws(
      () => loadEffectiveSecurityPolicy({
        studioPolicyPath: policyPath,
        studioPolicyRequiredPath: path.join(root, "no-marker"),
        requireStudioPolicy: true,
        baseDeniedPaths: [],
        user: unrestrictedUser
      }),
      /required but missing/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A managed policy change or removal blocks access until reload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const policyPath = path.join(root, "policy.json");
    const requiredPath = path.join(root, "policy.required");
    await writeFile(policyPath, JSON.stringify({
      version: 1,
      policyId: "managed",
      allowNetworkedAiOnThisMachine: true
    }), "utf8");
    const changed = loadEffectiveSecurityPolicy({
      studioPolicyPath: policyPath,
      studioPolicyRequiredPath: requiredPath,
      baseDeniedPaths: [],
      user: unrestrictedUser
    });
    assert.equal(typeof changed.policyFingerprint, "string");
    await writeFile(policyPath, JSON.stringify({
      version: 1,
      policyId: "managed-replaced",
      allowNetworkedAiOnThisMachine: true
    }), "utf8");
    assert.throws(() => changed.assertNetworkedAiAllowed(), /changed after startup/);

    const removed = loadEffectiveSecurityPolicy({
      studioPolicyPath: policyPath,
      studioPolicyRequiredPath: requiredPath,
      baseDeniedPaths: [],
      user: unrestrictedUser
    });
    await rm(policyPath);
    assert.throws(() => removed.assertNetworkedAiAllowed(), /changed after startup/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Deploying a managed policy during an unmanaged session blocks further access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const project = path.join(root, "project");
    const policyPath = path.join(root, "policy.json");
    await mkdir(project);
    const policy = loadEffectiveSecurityPolicy({
      studioPolicyPath: policyPath,
      studioPolicyRequiredPath: path.join(root, "policy.required"),
      baseDeniedPaths: [],
      user: unrestrictedUser
    });
    assert.equal(policy.assertHostPathAllowed(project), project);
    await writeFile(policyPath, JSON.stringify({ version: 1, policyId: "new-managed-policy" }), "utf8");
    assert.throws(() => policy.assertHostPathAllowed(project), /changed after startup/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Managed policy rejects unknown fields and defaults network allocation off", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const policyPath = path.join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify({ version: 1, policyId: "managed" }), "utf8");
    const policy = loadEffectiveSecurityPolicy({ studioPolicyPath: policyPath, baseDeniedPaths: [], user: unrestrictedUser });
    assert.equal(policy.allowNetworkedAiOnThisMachine, false);

    await writeFile(policyPath, JSON.stringify({
      version: 1,
      policyId: "managed",
      allowNetworkedAiOnThisMachne: true
    }), "utf8");
    assert.throws(
      () => loadEffectiveSecurityPolicy({ studioPolicyPath: policyPath, baseDeniedPaths: [], user: unrestrictedUser }),
      /unknown field: allowNetworkedAiOnThisMachne/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Omissions imply clone-only even for a personal policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const absentPolicyPath = path.join(root, "no-policy.json");
    const policy = loadEffectiveSecurityPolicy({
      studioPolicyPath: absentPolicyPath,
      baseDeniedPaths: [],
      user: { ...unrestrictedUser, omittedRepoPaths: ["settings/local"] }
    });
    assert.equal(policy.managed, false);
    assert.equal(policy.cloneOnly, true);
    assert.equal(blocksGlobalMemoryBriefing(policy), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Repository metadata cannot be presented as an omission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    assert.throws(
      () => loadEffectiveSecurityPolicy({
        studioPolicyPath: path.join(root, "no-policy.json"),
        baseDeniedPaths: [],
        user: { ...unrestrictedUser, omittedRepoPaths: [".git/objects"] }
      }),
      /Repository metadata cannot be omitted/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI-bound overlays ignore forbidden roots and omitted .drydock files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const allowed = path.join(root, "allowed");
    const blocked = path.join(root, "blocked");
    await Promise.all([mkdir(allowed), mkdir(blocked)]);
    const policy = loadEffectiveSecurityPolicy({
      studioPolicyPath: path.join(root, "no-policy.json"),
      baseDeniedPaths: [],
      user: { ...unrestrictedUser, allowedProjectRoots: [allowed] }
    });
    assert.deepEqual(filterPolicyOverlayRoots(policy, [allowed, blocked], ".drydock/recipes.json"), [allowed]);
    assert.equal(blocksGlobalMemoryBriefing(policy), true);

    const omitted = loadEffectiveSecurityPolicy({
      studioPolicyPath: path.join(root, "no-policy.json"),
      baseDeniedPaths: [],
      user: { ...unrestrictedUser, omittedRepoPaths: [".drydock"] }
    });
    assert.deepEqual(filterPolicyOverlayRoots(omitted, [allowed], ".drydock/recipes.json"), []);
    assert.equal(blocksGlobalMemoryBriefing(omitted), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI-bound overlay files cannot link into a denied folder", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const allowed = path.join(root, "allowed");
    const deniedOverlay = path.join(root, "denied", ".drydock");
    await Promise.all([mkdir(allowed), mkdir(deniedOverlay, { recursive: true })]);
    await writeFile(path.join(deniedOverlay, "recipes.json"), "[]", "utf8");
    try {
      await symlink(deniedOverlay, path.join(allowed, ".drydock"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("This account cannot create symbolic links or junctions.");
        return;
      }
      throw error;
    }

    const policy = loadEffectiveSecurityPolicy({
      studioPolicyPath: path.join(root, "no-policy.json"),
      baseDeniedPaths: [path.join(root, "denied")],
      user: { ...unrestrictedUser, allowedProjectRoots: [allowed] }
    });
    assert.equal(resolvePolicyOverlayFile(policy, allowed, path.join(allowed, ".drydock", "recipes.json")), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Managed validation-runtime limits parse, surface, and stay absent when unset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-validation-policy-"));
  try {
    const policyPath = path.join(root, "policy.json");
    await writeFile(policyPath, JSON.stringify({
      version: 1,
      policyId: "validation-limits",
      validationRuntimes: {
        topologyPin: "default-plus-named",
        warmCap: 2,
        profileExceptionCreation: "td-only",
        imageAllowlist: ["win11-maya2026", "win11-hou20.5"]
      }
    }), "utf8");

    const policy = loadEffectiveSecurityPolicy({ studioPolicyPath: policyPath, baseDeniedPaths: [], user: unrestrictedUser });
    assert.deepEqual(policy.validationRuntimes, {
      topologyPin: "default-plus-named",
      warmCap: 2,
      profileExceptionCreation: "td-only",
      imageAllowlist: ["win11-maya2026", "win11-hou20.5"]
    });
    assert.match(policy.summary().label, /Validation: topology pinned, warm cap 2, 2 allowed images/);

    const withoutKey = path.join(root, "plain.json");
    await writeFile(withoutKey, JSON.stringify({ version: 1, policyId: "no-validation-limits" }), "utf8");
    const plain = loadEffectiveSecurityPolicy({ studioPolicyPath: withoutKey, baseDeniedPaths: [], user: unrestrictedUser });
    assert.equal(plain.validationRuntimes, undefined);
    assert.equal(plain.summary().label, "Managed · Network blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Malformed validation-runtime limits fail closed and name the field", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-validation-policy-"));
  try {
    const policyPath = path.join(root, "policy.json");
    const write = async (validationRuntimes: unknown): Promise<void> => {
      await writeFile(policyPath, JSON.stringify({ version: 1, policyId: "validation-limits", validationRuntimes }), "utf8");
    };
    const load = (): unknown => loadEffectiveSecurityPolicy({ studioPolicyPath: policyPath, baseDeniedPaths: [], user: unrestrictedUser });

    await write({ warmCap: "2" });
    assert.throws(load, /validationRuntimes\.warmCap must be a non-negative whole number/);

    await write({ warmCap: -1 });
    assert.throws(load, /validationRuntimes\.warmCap must be a non-negative whole number/);

    await write({ topologyPin: "one-per-task" });
    assert.throws(load, /validationRuntimes\.topologyPin must be one of single, default-plus-named, per-project/);

    await write({ profileExceptionCreation: "anyone" });
    assert.throws(load, /validationRuntimes\.profileExceptionCreation must be td-only or disabled/);

    await write({ imageAllowlist: "win11-maya2026" });
    assert.throws(load, /validationRuntimes\.imageAllowlist must be an array of strings/);

    await write(["default-plus-named"]);
    assert.throws(load, /validationRuntimes must be an object/);

    // Strict inside the object too: a misspelled limit must not silently leave
    // a validation runtime unrestricted.
    await write({ warmCapp: 2 });
    assert.throws(load, /validationRuntimes contains unknown field: warmCapp/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI-bound overlay targets honor repo-relative omissions after canonicalization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "drydock-policy-"));
  try {
    const project = path.join(root, "project");
    const omitted = path.join(project, "config", "local");
    await mkdir(omitted, { recursive: true });
    const target = path.join(omitted, "recipes.json");
    await writeFile(target, "[]", "utf8");
    const policy = loadEffectiveSecurityPolicy({
      studioPolicyPath: path.join(root, "no-policy.json"),
      baseDeniedPaths: [],
      user: { ...unrestrictedUser, omittedRepoPaths: ["config/local"] }
    });
    assert.equal(resolvePolicyOverlayFile(policy, project, target), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
