/**
 * Remote project picker tests (plan D2): search-result parsing tolerates
 * junk, destination mapping is traversal-safe, and clones are https-only.
 * REST runs against canned JSON - no network.
 */

import { strict as assert } from "node:assert";
import path from "node:path";
import test from "node:test";
import { remoteCloneDestination, searchGitHub, searchGitLab } from "./remoteProjects.js";

test("searchGitHub parses hits and drops malformed items", async () => {
  const hits = await searchGitHub("usd", "token-1", async (url, headers) => {
    assert.match(url, /api\.github\.com\/search\/repositories/);
    assert.equal(headers["Authorization"], "Bearer token-1");
    return {
      items: [
        { full_name: "PixarAnimationStudios/OpenUSD", clone_url: "https://github.com/PixarAnimationStudios/OpenUSD.git", html_url: "https://github.com/PixarAnimationStudios/OpenUSD", default_branch: "dev", private: false, description: "Universal Scene Description" },
        { nonsense: true },
        { full_name: 42, clone_url: "https://x" }
      ]
    };
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.remotePath, "PixarAnimationStudios/OpenUSD");
  assert.equal(hits[0]?.defaultBranch, "dev");
  assert.equal(hits[0]?.isPrivate, false);
});

test("searchGitLab parses hits from any host and flags non-public as private", async () => {
  const hits = await searchGitLab("gitlab.mystudio.local", "shot", "pat-1", async (url, headers) => {
    assert.match(url, /^https:\/\/gitlab\.mystudio\.local\/api\/v4\/projects\?/);
    assert.equal(headers["PRIVATE-TOKEN"], "pat-1");
    return [
      { path_with_namespace: "pipeline/usd_shot_tools", http_url_to_repo: "https://gitlab.mystudio.local/pipeline/usd_shot_tools.git", visibility: "internal", web_url: "https://gitlab.mystudio.local/pipeline/usd_shot_tools" },
      "junk"
    ];
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.isPrivate, true);
});

test("remoteCloneDestination maps host/org/repo safely and refuses traversal shapes", () => {
  const dest = remoteCloneDestination(path.join("root", "projects"), "gitlab.mystudio.local", "pipeline/usd_shot_tools");
  assert.equal(dest, path.join("root", "projects", "gitlab.mystudio.local", "pipeline", "usd_shot_tools"));
  // Unsafe characters neutralize instead of escaping the root.
  const odd = remoteCloneDestination("root", "github.com", "we!rd/na me");
  assert.equal(odd, path.join("root", "github.com", "we_rd", "na_me"));
  assert.throws(() => remoteCloneDestination("root", "github.com", "../evil"), /cannot map/);
  assert.throws(() => remoteCloneDestination("root", "github.com", "a//b"), /cannot map/);
});
