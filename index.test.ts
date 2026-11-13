import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const home = mkdtempSync(join(tmpdir(), "run-mode-events-"));
const previousHome = process.env.HOME;
process.env.HOME = home;
mkdirSync(join(home, ".pi/agent"), { recursive: true });
const { default: extension } = await import("./index.ts");
const { STATE_FILE_PATH } = await import("./core/types.ts");
const { resolveProjectKey } = await import("./core/project.ts");
assert.ok(STATE_FILE_PATH.startsWith(home));
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
const a = { provider: "test", id: "global" };
const b = { provider: "test", id: "project" };
const c = { provider: "test", id: "chosen" };
const globalRef = { ...a, thinkingLevel: "high" };
const projectRef = { ...b, thinkingLevel: "low" };
const defaults = () => ({ modeModels: { ask: globalRef, plan: { ...a, thinkingLevel: "max" }, auto: globalRef } });
const readConfig = () => JSON.parse(readFileSync(STATE_FILE_PATH, "utf8"));
const writeConfig = (value: unknown) => writeFileSync(STATE_FILE_PATH, JSON.stringify(value));
beforeEach(() => writeConfig(defaults()));

function harness(name: string, mode = "tui", entries: any[] = []) {
  const cwd = join(home, name);
  mkdirSync(cwd, { recursive: true });
  const key = resolveProjectKey(cwd);
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands = new Map<string, any>();
  const dialogs: any[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  let currentModel = a;
  let thinkingLevel = "medium";
  let allowModel = true;
  let unavailable = "";
  const ctx = {
    cwd, mode, hasUI: true,
    get model() { return currentModel; },
    modelRegistry: {
      find: (provider: string, id: string) => id === unavailable ? undefined : ({ provider, id }),
      getAvailable: () => [a, b, c],
    },
    sessionManager: { getSessionId: () => name, getEntries: () => entries },
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      setStatus() {}, setWorkingVisible() {},
      custom: async () => dialogs.shift(),
    },
    waitForIdle: async () => {},
  };
  async function emit(name: string, event: unknown = {}) {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  }
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...handlers.get(name) ?? [], handler]);
    },
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerShortcut() {}, registerTool() {}, registerFlag() {}, registerMessageRenderer() {},
    getFlag: () => false,
    getActiveTools: () => [], setActiveTools() {},
    events: { emit() {} },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel(level: string) {
      if (thinkingLevel === level) return;
      thinkingLevel = level;
      void emit("thinking_level_select", { level });
    },
    async setModel(model: typeof a) {
      if (!allowModel) return false;
      const previousModel = currentModel;
      currentModel = model;
      pi.setThinkingLevel("medium");
      if (previousModel.id !== model.id) await emit("model_select", { model, previousModel, source: "set" });
      return true;
    },
  };
  extension(pi as unknown as ExtensionAPI);
  return {
    key, entries, notices, dialogs, emit, pi,
    model: () => currentModel,
    thinking: () => thinkingLevel,
    command: (args: string) => commands.get("run-mode").handler(args, ctx),
    failModel() { allowModel = false; },
    missingModel(id: string) { unavailable = id; },
  };
}

test("early events cannot persist ask mode or change global preferences", async () => {
  const h = harness("early");
  const before = readFileSync(STATE_FILE_PATH, "utf8");
  await h.pi.setModel(c);
  h.pi.setThinkingLevel("max");
  assert.equal(h.entries.length, 0);
  assert.equal(readFileSync(STATE_FILE_PATH, "utf8"), before);
  await h.emit("session_start");
  assert.deepEqual(h.model(), a);
  assert.equal(h.thinking(), "high");
});

test("default model selection still saves globally without creating a project", async () => {
  const h = harness("global");
  await h.emit("session_start");
  await h.pi.setModel(c);
  h.pi.setThinkingLevel("low");
  assert.deepEqual(readConfig().modeModels.ask, { ...c, thinkingLevel: "low" });
  assert.deepEqual(readConfig().modeModels.auto, { ...c, thinkingLevel: "low" });
  assert.equal(readConfig().projects, undefined);
});

test("project on/off/status applies immediately, retains bindings and isolates other projects", async () => {
  const h = harness("toggle");
  writeConfig({ ...defaults(), projects: { [h.key]: { enabled: false, modeModels: { auto: projectRef } } } });
  await h.emit("session_start");
  assert.deepEqual(h.model(), a);
  await h.command("project on");
  assert.deepEqual(h.model(), b);
  assert.equal(h.thinking(), "low");
  assert.equal(readConfig().projects[h.key].enabled, true);
  await h.command("project");
  assert.match(h.notices.at(-1)!.message, /Project model memory: on/);
  assert.ok(h.notices.at(-1)!.message.includes(h.key));
  await h.pi.setModel(c);
  h.pi.setThinkingLevel("max");
  assert.deepEqual(readConfig().modeModels, defaults().modeModels);
  assert.deepEqual(readConfig().projects[h.key].modeModels.auto, { ...c, thinkingLevel: "max" });
  const other = harness("another-project");
  await other.emit("session_start");
  assert.deepEqual(other.model(), a);
  await h.command("project off");
  assert.deepEqual(h.model(), a);
  assert.equal(h.thinking(), "high");
  assert.equal(readConfig().projects[h.key].enabled, false);
  await h.command("project on");
  assert.deepEqual(h.model(), c);
  assert.equal(h.thinking(), "max");
  const fresh = harness("toggle");
  await fresh.emit("session_start");
  assert.deepEqual(fresh.model(), c);
  assert.equal(fresh.thinking(), "max");
});

test("on does not snapshot inherited defaults and on/off is idempotent", async () => {
  const h = harness("new-project");
  await h.emit("session_start");
  await h.command("project on");
  assert.deepEqual(readConfig().projects[h.key], { enabled: true });
  await h.command("project on");
  assert.deepEqual(readConfig().projects[h.key], { enabled: true });
  await h.command("project off");
  await h.command("project off");
  assert.deepEqual(readConfig().projects[h.key], { enabled: false });
  await h.pi.setModel(c);
  assert.equal(readConfig().modeModels.ask.id, c.id);
  assert.deepEqual(readConfig().projects[h.key], { enabled: false });
});

test("startup, reload and mode changes never rewrite enabled project preferences", async () => {
  const h = harness("no-write");
  writeConfig({ ...defaults(), projects: { [h.key]: { enabled: true, modeModels: { auto: projectRef } } } });
  const before = readFileSync(STATE_FILE_PATH, "utf8");
  await h.emit("session_start");
  await h.command("plan");
  assert.equal(h.thinking(), "max");
  await h.command("auto");
  assert.equal(h.thinking(), "low");
  await h.emit("session_start", { reason: "reload" });
  assert.equal(readFileSync(STATE_FILE_PATH, "utf8"), before);
});

test("restoring an old session overrides runtime but does not overwrite newer project choices", async () => {
  const entries = [{ type: "custom", customType: "agent-mode-state", data: { mode: "auto", modeModels: { ask: { ...c, thinkingLevel: "high" }, auto: { ...c, thinkingLevel: "high" } } } }];
  const h = harness("session", "tui", entries);
  const config = { ...defaults(), projects: { [h.key]: { enabled: true, modeModels: { auto: projectRef } } } };
  writeConfig(config);
  await h.emit("session_start");
  assert.deepEqual(h.model(), c);
  assert.equal(h.thinking(), "high");
  assert.deepEqual(readConfig(), config);
  await h.command("project off");
  assert.deepEqual(h.model(), a);
  await h.emit("session_start", { reason: "reload" });
  assert.deepEqual(h.model(), a);
});

test("old project sessions cannot leak restored bindings into global preferences", async () => {
  const entries = [{ type: "custom", customType: "agent-mode-state", data: { mode: "auto", modeModels: { ask: projectRef, plan: projectRef, auto: projectRef } } }];
  const h = harness("disabled-session", "tui", entries);
  const config = { ...defaults(), projects: { [h.key]: { enabled: false, modeModels: { auto: projectRef } } } };
  writeConfig(config);
  await h.emit("session_start");
  assert.deepEqual(h.model(), b);
  await h.command("plan");
  assert.deepEqual(readConfig(), config);
  await h.command("auto");
  await h.pi.setModel(c);
  assert.deepEqual(readConfig().modeModels.plan, config.modeModels.plan);
  assert.equal(readConfig().modeModels.auto.id, c.id);
});

test("scope switches restore Pi thinking defaults even when the model is unchanged", async () => {
  const h = harness("thinking-default");
  writeConfig({ modeModels: { ask: a, plan: null, auto: a }, projects: { [h.key]: { enabled: false, modeModels: { auto: { ...a, thinkingLevel: "low" } } } } });
  await h.emit("session_start");
  assert.equal(h.thinking(), "medium");
  await h.command("project on");
  assert.equal(h.thinking(), "low");
  await h.command("project off");
  assert.equal(h.thinking(), "medium");
});

test("a second session cannot silently re-enable a project disabled elsewhere", async () => {
  const h = harness("shared-scope");
  await h.emit("session_start");
  await h.command("project on");
  const other = harness("shared-scope");
  await other.emit("session_start");
  await h.command("project off");
  await other.pi.setModel(c);
  assert.equal(readConfig().projects[h.key].enabled, false);
  assert.equal(readConfig().projects[h.key].modeModels, undefined);
  assert.equal(readConfig().modeModels.auto.id, c.id);
});

test("Execute with saves the selected auto model to the project and sync group", async () => {
  const h = harness("execute-with");
  await h.emit("session_start");
  await h.command("project on");
  await h.command("plan");
  h.dialogs.push({ value: "execute_with", note: "" }, c);
  await h.emit("tool_call", { toolName: "plan_approve", input: {} });
  assert.deepEqual(h.model(), c);
  assert.equal(readConfig().projects[h.key].modeModels.auto.id, c.id);
  assert.equal(readConfig().projects[h.key].modeModels.ask.id, c.id);
  assert.equal(readConfig().projects[h.key].modeModels.plan, undefined);
  assert.deepEqual(readConfig().modeModels, defaults().modeModels);
});

test("RPC does not restore, record model preferences, or enable project settings", async () => {
  const h = harness("rpc", "rpc");
  writeConfig({ ...defaults(), projects: { [h.key]: { enabled: true, modeModels: { auto: projectRef } } } });
  const before = readFileSync(STATE_FILE_PATH, "utf8");
  await h.emit("session_start");
  assert.deepEqual(h.model(), a);
  await h.pi.setModel(c);
  h.pi.setThinkingLevel("max");
  await h.command("plan");
  await h.command("project off");
  assert.equal(readFileSync(STATE_FILE_PATH, "utf8"), before);
  assert.deepEqual(h.model(), c);
  assert.match(h.notices.at(-1)!.message, /RPC hosts own model selection/);
});

test("bad arguments and malformed configs do not enable project memory", async () => {
  const h = harness("bad-config");
  await h.emit("session_start");
  await h.command("project maybe");
  assert.equal(h.notices.at(-1)!.level, "warning");
  assert.equal(readConfig().projects, undefined);
  writeFileSync(STATE_FILE_PATH, "{broken");
  await h.command("project on");
  assert.equal(readFileSync(STATE_FILE_PATH, "utf8"), "{broken");
  assert.equal(h.notices.at(-1)!.level, "error");
});

test("failed model restoration reports a warning without claiming a successful switch", async () => {
  const h = harness("unavailable");
  writeConfig({ ...defaults(), projects: { [h.key]: { enabled: false, modeModels: { auto: projectRef } } } });
  await h.emit("session_start");
  h.failModel();
  await h.command("project on");
  assert.deepEqual(h.model(), a);
  assert.equal(h.thinking(), "high");
  assert.match(h.notices.at(-1)!.message, /unavailable; current model unchanged/);
  assert.equal(h.notices.at(-1)!.level, "warning");
  const fresh = harness("missing");
  fresh.missingModel("global");
  await fresh.emit("session_start");
  assert.equal(fresh.notices.at(-1)!.level, "warning");
});
