/**
 * Mode switching: setMode (save current model to the outgoing mode, restore
 * the incoming mode's model, record the transition for plan lifecycle) plus
 * optional cycle shortcut and /run-mode command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyModelToSyncGroup } from "../core/model-binding.ts";
import { persistState, type RuntimeState } from "../core/state.ts";
import { MODES, type Mode, type SetMode } from "../core/types.ts";
import { emitFooterMode, updateStatus } from "./indicator.ts";

export function createSetMode(pi: ExtensionAPI, state: RuntimeState): SetMode {
  return async function setMode(newMode: Mode): Promise<void> {
    if (newMode === state.mode) {
      persistState(pi, state);
      updateStatus(state);
      emitFooterMode(pi, state);
      return;
    }
    // Record transition for the plan lifecycle one-shot notice.
    if (newMode === "plan") state.modeTransition = "to_plan";
    else if (state.mode === "plan") state.modeTransition = "from_plan";
    // Save current model to current mode before switching.
    if (state.currentModelRef) {
      applyModelToSyncGroup(state, state.mode, state.currentModelRef);
    }
    state.mode = newMode;
    // Entering plan resets the inject throttle.
    if (newMode === "plan") {
      state.planPromptInjected = false;
      state.planTurnsSinceInject = 0;
    }
    // Restore model for target mode.
    if (state.modeModels[newMode] && state.currentCtx) {
      const model = state.currentCtx.modelRegistry.find(
        state.modeModels[newMode]!.provider,
        state.modeModels[newMode]!.id,
      );
      if (model) {
        await pi.setModel(model);
      }
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
    const idx = MODES.indexOf(state.mode);
    const next = MODES[(idx + 1) % MODES.length];
    await setMode(next);
  }

  // Optional: omit / null / "" in config → no shortcut (avoids shift+tab vs
  // app.thinking.cycle). Set cycleShortcut in pi-run-mode.json to enable.
  if (cycleShortcut) {
    pi.registerShortcut(cycleShortcut, {
      description: "Cycle mode: ask → plan → auto",
      handler: async () => {
        if (!state.currentCtx) return;
        await cycleMode();
      },
    });
  }

  pi.registerCommand("run-mode", {
    description: "Show or set run mode (ask/plan/auto); cycle with toggle",
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase();
      if (cmd === "") {
        const shortcutHint = cycleShortcut
          ? ` · shortcut: ${cycleShortcut}`
          : "";
        ctx.ui.notify(
          `Mode: ${state.mode} (ask → plan → auto)${shortcutHint}\n` +
            `Usage: /run-mode ask|plan|auto · /run-mode toggle`,
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
        `Unknown mode: ${cmd}. Use: ask, plan, auto, toggle`,
        "warning",
      );
    },
  });
}
