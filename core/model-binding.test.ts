import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyModelToSyncGroup, restoreModeModel, switchModel } from "./model-binding.ts";
import { createRuntimeState } from "./state.ts";

test("bindings preserve thinking unless explicitly changed", () => {
  const state = createRuntimeState();
  state.modeModels.auto = { provider: "test", id: "a", thinkingLevel: "high" };
  applyModelToSyncGroup(state, "ask", { provider: "test", id: "b" });
  assert.equal(state.modeModels.auto?.thinkingLevel, "high");
  applyModelToSyncGroup(state, "auto", { provider: "test", id: "b", thinkingLevel: "low" });
  assert.equal(state.modeModels.ask?.thinkingLevel, "low");
  assert.equal(state.modeModels.plan, null);
});

test("restoring guards both model and thinking events and returns switch status", async () => {
  const state = createRuntimeState();
  state.modeModels.ask = { provider: "test", id: "bound", thinkingLevel: "high" };
  state.currentCtx = { mode: "tui", modelRegistry: { find: () => ({ provider: "test", id: "bound" }) } } as unknown as ExtensionContext;
  const calls: string[] = [];
  const pi = {
    async setModel() { assert.ok(state.modelSwitchDepth > 0); calls.push("model"); return true; },
    setThinkingLevel() { assert.ok(state.modelSwitchDepth > 0); calls.push("thinking"); },
  } as unknown as ExtensionAPI;
  assert.equal(await restoreModeModel(pi, state), true);
  assert.deepEqual(calls, ["model", "thinking"]);
  assert.equal(state.modelSwitchDepth, 0);
  assert.deepEqual(state.currentModelRef, { provider: "test", id: "bound" });
  calls.length = 0;
  assert.equal(await restoreModeModel(pi, state), true);
  assert.deepEqual(calls, ["thinking"]);
});

test("unavailable models do not change thinking or current model", async () => {
  const state = createRuntimeState();
  state.modeModels.ask = { provider: "test", id: "missing", thinkingLevel: "high" };
  state.currentModelRef = { provider: "test", id: "original" };
  state.currentCtx = { mode: "tui", modelRegistry: { find: () => undefined } } as unknown as ExtensionContext;
  const pi = { setThinkingLevel() { assert.fail("must not change thinking"); }, async setModel() { return false; } } as unknown as ExtensionAPI;
  assert.equal(await restoreModeModel(pi, state), false);
  state.currentCtx = { mode: "tui", modelRegistry: { find: () => ({ provider: "test", id: "missing" }) } } as unknown as ExtensionContext;
  assert.equal(await restoreModeModel(pi, state), false);
  assert.equal(state.currentModelRef.id, "original");
  assert.equal(state.modelSwitchDepth, 0);
});

test("RPC restoration is a no-op", async () => {
  const state = createRuntimeState();
  state.modeModels.ask = { provider: "test", id: "bound" };
  state.currentCtx = { mode: "rpc" } as ExtensionContext;
  assert.equal(await restoreModeModel({} as ExtensionAPI, state), true);
});

test("switch guards unwind on exceptions and overlapping calls", async () => {
  const state = createRuntimeState();
  const pending: Array<() => void> = [];
  const pi = { setModel: () => new Promise<boolean>((resolve) => pending.push(() => resolve(true))) } as unknown as ExtensionAPI;
  const model = { provider: "test", id: "bound" } as Parameters<ExtensionAPI["setModel"]>[0];
  const first = switchModel(pi, state, model);
  const second = switchModel(pi, state, model);
  assert.equal(state.modelSwitchDepth, 2);
  pending[0]();
  await first;
  assert.equal(state.modelSwitchDepth, 1);
  pending[1]();
  await second;
  assert.equal(state.modelSwitchDepth, 0);
  await assert.rejects(switchModel({ setModel: async () => { throw new Error("failed"); } } as unknown as ExtensionAPI, state, model));
  assert.equal(state.modelSwitchDepth, 0);
});
