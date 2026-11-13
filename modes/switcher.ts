/**
 * Mode switching: setMode (save current model to the outgoing mode, restore
 * the incoming mode's model, record the transition for plan lifecycle) plus
 * optional cycle shortcut and /run-mode command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyModelToSyncGroup, restoreModeModel } from "../core/model-binding.ts";
import {
  loadModelBindings,
  loadStateFile,
  persistState,
  recordSessionState,
  setProjectEnabled,
  type RuntimeState,
} from "../core/state.ts";
import { MODES, type Mode, type SetMode } from "../core/types.ts";
import { emitFooterMode, updateStatus } from "./indicator.ts";

export function createSetMode(pi: ExtensionAPI, state: RuntimeState): SetMode {
  return async function setMode(newMode: Mode): Promise<void> {
    // RPC hosts own model selection (see index.ts session_start): the mode
    // binding neither overwrites their model nor records it into the config.
    const hostOwnsModel = state.currentCtx?.mode === "rpc";

    if (newMode === state.mode) {
      if (!hostOwnsModel) {
        const current = state.modeModels[state.mode];
        if (current) current.thinkingLevel = pi.getThinkingLevel();
      }
      persistState(pi, state);
      updateStatus(state);
      emitFooterMode(pi, state);
      return;
    }
    // Record transition for the plan lifecycle one-shot notice.
    if (newMode === "plan") state.modeTransition = "to_plan";
    else if (state.mode === "plan") state.modeTransition = "from_plan";
    if (!hostOwnsModel) {
      // Save the current model and thinking level before switching.
      if (state.currentModelRef) {
        applyModelToSyncGroup(state, state.mode, state.currentModelRef);
      }
      const current = state.modeModels[state.mode];
      if (current) current.thinkingLevel = pi.getThinkingLevel();
    }
    state.mode = newMode;
    // Entering plan resets the inject throttle.
    if (newMode === "plan") {
      state.planPromptInjected = false;
      state.planTurnsSinceInject = 0;
    }
    // Restore model for target mode.
    if (!await restoreModeModel(pi, state)) {
      state.currentCtx?.ui.notify("Could not restore the configured mode model.", "warning");
    }
    persistState(pi, state);
    updateStatus(state);
    emitFooterMode(pi, state);
  };
}

export function registerModeControls(
  pi: ExtensionAPI,
  state: RuntimeState,
  setMode: SetMode,
  cycleShortcut: string | null,
): void {
  async function cycleMode(): Promise<void> {
    const order = state.cycleModes;
    const idx = order.indexOf(state.mode);
    const next = order[(idx + 1) % order.length];
    await setMode(next);
  }

  // Optional: omit / null / "" in config → no shortcut (avoids shift+tab vs
  // app.thinking.cycle). Set cycleShortcut in pi-run-mode.json to enable.
  if (cycleShortcut) {
    pi.registerShortcut(cycleShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
      description: "Cycle mode: ask → plan → auto",
      handler: async () => {
        if (!state.currentCtx) return;
        await cycleMode();
      },
    });
  }

  pi.registerCommand("run-mode", {
    description: "Set run mode, cycle with toggle, or configure project model memory",
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase();
      if (cmd === "project" || cmd.startsWith("project ")) {
        const action = cmd.slice("project".length).trim();
        if (action !== "" && action !== "on" && action !== "off") {
          ctx.ui.notify("Usage: /run-mode project [on|off]", "warning");
          return;
        }
        if (action) {
          if (ctx.mode === "rpc") {
            ctx.ui.notify("RPC hosts own model selection; project settings are read-only here.", "warning");
            return;
          }
          await ctx.waitForIdle();
          if (!setProjectEnabled(state, action === "on")) return;
          loadModelBindings(state, loadStateFile());
          const restored = await restoreModeModel(pi, state, { fallback: true, forceModel: true });
          recordSessionState(pi, state);
          ctx.ui.notify(
            `Project model memory: ${state.projectEnabled ? "on" : "off"}` +
              (restored ? "" : " · configured model unavailable; current model unchanged"),
            restored ? "info" : "warning",
          );
          return;
        }
        const bindings = MODES.map((mode) => {
          const ref = state.modeModels[mode];
          return `${mode}: ${ref ? `${ref.provider}/${ref.id}${ref.thinkingLevel ? ` (${ref.thinkingLevel})` : ""}` : "unbound (current model)"}`;
        });
        ctx.ui.notify(
          `Project: ${state.projectKey ?? ctx.cwd}\n` +
            `Project model memory: ${state.projectEnabled ? "on" : "off (global)"}\n` +
            bindings.join("\n") + "\nUsage: /run-mode project on|off",
          "info",
        );
        return;
      }
      if (cmd === "") {
        const shortcutHint = cycleShortcut
          ? ` · shortcut: ${cycleShortcut}`
          : "";
        ctx.ui.notify(
          `Mode: ${state.mode} (${state.cycleModes.join(" → ")})${shortcutHint}\n` +
            `Models: ${state.projectEnabled ? "project" : "global"} · ${state.projectKey ?? ctx.cwd}\n` +
            `Usage: /run-mode ${state.cycleModes.join("|")} · /run-mode toggle · /run-mode project [on|off]`,
          "info",
        );
        return;
      }
      if (cmd === "toggle" || cmd === "cycle" || cmd === "next") {
        await cycleMode();
        ctx.ui.notify(`Mode: ${state.mode}`, "info");
        return;
      }
      if (MODES.includes(cmd as Mode)) {
        await setMode(cmd as Mode);
        ctx.ui.notify(`Mode: ${state.mode}`, "info");
        return;
      }
      ctx.ui.notify(
        `Unknown mode: ${cmd}. Use: ask, plan, auto, toggle, project [on|off]`,
        "warning",
      );
    },
  });
}
