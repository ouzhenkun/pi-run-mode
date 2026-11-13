import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { resolveProjectKey } from "./project.ts";

const fixture = realpathSync(mkdtempSync(join(tmpdir(), "run-mode-project-")));
after(() => rmSync(fixture, { recursive: true, force: true }));
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}
const repo = join(fixture, "repo with spaces");
mkdirSync(repo);
git(repo, "init");
git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
const worktree = join(fixture, "worktree");
git(repo, "worktree", "add", "-b", "task", worktree);

test("repository root, subdirectories and linked worktrees share a key", () => {
  const child = join(repo, "src");
  mkdirSync(child);
  assert.equal(resolveProjectKey(repo), repo);
  assert.equal(resolveProjectKey(child), repo);
  assert.equal(resolveProjectKey(worktree), repo);
});

test("symlinks resolve to the same project", () => {
  const link = join(fixture, "link");
  symlinkSync(worktree, link);
  assert.equal(resolveProjectKey(link), repo);
});

test("non-Git directories use their canonical cwd", () => {
  const directory = join(fixture, "ordinary");
  mkdirSync(directory);
  const link = join(fixture, "ordinary-link");
  symlinkSync(directory, link);
  assert.equal(resolveProjectKey(directory), directory);
  assert.equal(resolveProjectKey(link), directory);
  assert.equal(resolveProjectKey(join(fixture, "missing")), join(fixture, "missing"));
});

test("clones, nested repositories and submodules are independent projects", () => {
  const clone = join(fixture, "clone");
  git(fixture, "clone", repo, clone);
  assert.equal(resolveProjectKey(clone), clone);
  const nested = join(repo, "nested");
  mkdirSync(nested);
  git(nested, "init");
  assert.equal(resolveProjectKey(nested), nested);
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", clone, "module");
  const moduleKey = resolveProjectKey(join(repo, "module"));
  assert.notEqual(moduleKey, repo);
  assert.notEqual(moduleKey, clone);
  assert.equal(moduleKey, realpathSync(join(repo, ".git/modules/module")));
});

test("Git environment overrides do not change project identity", () => {
  const original = process.env.GIT_DIR;
  process.env.GIT_DIR = "/nonexistent";
  try {
    assert.equal(resolveProjectKey(repo), repo);
  } finally {
    if (original === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = original;
  }
});
