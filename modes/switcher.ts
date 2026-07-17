/**
 * Mode switching: setMode (save current model to the outgoing mode, restore
 * the incoming mode's model, record the transition for plan lifecycle) plus
 * the Shift+Tab shortcut and /mode command.
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
): void {
  async function cycleMode(): Promise<void> {
    const idx = MODES.indexOf(state.mode);
    const next = MODES[(idx + 1) % MODES.length];
    await setMode(next);
  }

  pi.registerShortcut("shift+tab", {
    description: "Cycle mode: ask → plan → auto",
    handler: async () => {
      if (!state.currentCtx) return;
      await cycleMode();
    },
  });

  pi.registerCommand("mode", {
    description: "Set agent mode (ask/plan/auto)",
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase() as Mode;
      if (MODES.includes(cmd)) {
        await setMode(cmd);
      } else if (cmd === "" || cmd === "toggle") {
        await cycleMode();
      } else {
        ctx.ui.notify(`Unknown mode: ${cmd}. Use: ask, plan, auto`, "warning");
      }
    },
  });
}
