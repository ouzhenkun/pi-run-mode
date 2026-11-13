import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentModeState } from "./state.ts";

const home = mkdtempSync(join(tmpdir(), "run-mode-state-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
mkdirSync(join(home, ".pi/agent"), { recursive: true });
const { createRuntimeState, loadModelBindings, loadStateFile, persistState, restoreState, saveStateFile, setProjectEnabled } = await import("./state.ts");
const { STATE_FILE_PATH } = await import("./types.ts");
assert.ok(STATE_FILE_PATH.startsWith(home));
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => writeFileSync(STATE_FILE_PATH, "{}"));
const globalRef = { provider: "test", id: "global", thinkingLevel: "high" as const };
const projectRef = { provider: "test", id: "project", thinkingLevel: "low" as const };
const pi = { appendEntry() {} } as unknown as ExtensionAPI;
function runtime(config: AgentModeState) {
  const state = createRuntimeState();
  state.initialized = true;
  state.projectKey = "/project-a";
  state.currentCtx = { mode: "tui", ui: { notify() {} } } as unknown as ExtensionContext;
  loadModelBindings(state, config);
  return state;
}
function defaults(): AgentModeState {
  return { modeModels: { ask: globalRef, plan: null, auto: globalRef } };
}

test("old configs and disabled projects retain global bindings", () => {
  const config = { ...defaults(), projects: { "/project-a": { modeModels: { auto: projectRef } } } };
  const state = runtime(config);
  assert.equal(state.projectEnabled, false);
  assert.deepEqual(state.modeModels.auto, globalRef);
});

test("enabled project overrides a sync group before inherited values", () => {
  const state = runtime({ ...defaults(), projects: { "/project-a": { enabled: true, modeModels: { auto: projectRef } } } });
  assert.equal(state.projectEnabled, true);
  assert.deepEqual(state.modeModels.ask, projectRef);
  assert.deepEqual(state.modeModels.auto, projectRef);
  assert.equal(state.modeModels.plan, null);
  loadModelBindings(state, defaults());
  assert.equal(state.projectEnabled, false);
  assert.deepEqual(state.modeModels.auto, globalRef);
});

test("project on/off retains models and other config, including unknown fields", () => {
  const config = { ...defaults(), custom: { keep: true }, projects: { "/project-a": { enabled: false, modeModels: { auto: projectRef } }, "/project-b": { enabled: true } } };
  writeFileSync(STATE_FILE_PATH, JSON.stringify(config));
  const state = runtime(config);
  assert.equal(setProjectEnabled(state, true), true);
  const enabled = loadStateFile();
  assert.equal(enabled.projects?.["/project-a"].enabled, true);
  assert.deepEqual(enabled.projects?.["/project-a"].modeModels, config.projects["/project-a"].modeModels);
  assert.equal(setProjectEnabled(state, false), true);
  assert.deepEqual(loadStateFile(), config);
});

test("global writes preserve project entries and user-authored config", () => {
  const config = { ...defaults(), custom: [1, 2], syncModels: ["ask", "auto"], projects: { "/project-b": { enabled: true } } };
  writeFileSync(STATE_FILE_PATH, JSON.stringify(config));
  saveStateFile({ modeModels: { ask: projectRef, plan: null, auto: projectRef } });
  assert.deepEqual(JSON.parse(readFileSync(STATE_FILE_PATH, "utf8")), { ...config, modeModels: { ask: projectRef, plan: null, auto: projectRef } });
});

test("only selected project modes are saved, not inherited bindings or another project", () => {
  const config = { ...defaults(), projects: { "/project-a": { enabled: true }, "/project-b": { enabled: true, modeModels: { plan: globalRef } } } };
  writeFileSync(STATE_FILE_PATH, JSON.stringify(config));
  const state = runtime(config);
  state.modeModels.ask = projectRef;
  state.modeModels.auto = projectRef;
  persistState(pi, state, "auto");
  const saved = loadStateFile();
  assert.deepEqual(saved.modeModels, config.modeModels);
  assert.deepEqual(saved.projects?.["/project-b"], config.projects["/project-b"]);
  assert.deepEqual(saved.projects?.["/project-a"].modeModels, { ask: projectRef, auto: projectRef });
  const before = readFileSync(STATE_FILE_PATH, "utf8");
  persistState(pi, state);
  assert.equal(readFileSync(STATE_FILE_PATH, "utf8"), before);
});

test("saving merges the latest other project edits", () => {
  const config = { ...defaults(), projects: { "/project-a": { enabled: true } } };
  writeFileSync(STATE_FILE_PATH, JSON.stringify(config));
  const state = runtime(config);
  writeFileSync(STATE_FILE_PATH, JSON.stringify({ ...config, projects: { ...config.projects, "/project-b": { enabled: true, modeModels: { plan: projectRef } } } }));
  persistState(pi, state, "plan");
  assert.deepEqual(loadStateFile().projects?.["/project-b"].modeModels?.plan, projectRef);
});

test("session snapshots override bindings without rewriting preferences", () => {
  const config = { ...defaults(), projects: { "/project-a": { enabled: true } } };
  writeFileSync(STATE_FILE_PATH, JSON.stringify(config));
  const state = runtime(config);
  restoreState(state, { sessionManager: { getEntries: () => [{ type: "custom", customType: "agent-mode-state", data: { mode: "auto", modeModels: { auto: projectRef } } }] } } as unknown as ExtensionContext);
  assert.equal(state.mode, "auto");
  assert.deepEqual(state.modeModels.auto, projectRef);
  persistState(pi, state);
  assert.deepEqual(loadStateFile(), config);
});

test("RPC and uninitialized runtimes cannot write preferences", () => {
  const state = runtime(defaults());
  state.currentCtx = { mode: "rpc" } as ExtensionContext;
  persistState(pi, state, "auto");
  assert.deepEqual(loadStateFile(), {});
  state.initialized = false;
  let entries = 0;
  persistState({ appendEntry() { entries++; } } as unknown as ExtensionAPI, state, "auto");
  assert.equal(entries, 0);
});

test("invalid JSON is never overwritten and save failures are reported", () => {
  const notices: string[] = [];
  const state = runtime(defaults());
  state.currentCtx!.ui.notify = (message) => { notices.push(message); };
  for (const invalid of ["{broken", "null", "[]", "42"]) {
    writeFileSync(STATE_FILE_PATH, invalid);
    assert.deepEqual(loadStateFile(), {});
    assert.equal(setProjectEnabled(state, true), false);
    persistState(pi, state, "auto");
    assert.equal(readFileSync(STATE_FILE_PATH, "utf8"), invalid);
  }
  assert.equal(notices.length, 8);
});
