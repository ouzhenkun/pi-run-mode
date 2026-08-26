/**
 * Mode↔model binding helpers. A "sync group" is a set of modes that always
 * share one model (user config); changes to any member propagate to all.
 */

import type { Mode, ModelRef } from "./types.ts";
import type { RuntimeState } from "./state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Run pi.setModel inside the model-switch guard: pi forces the default
// thinking level when switching models and emits thinking_level_select; that
// event is a forced side effect, not a user choice, so thinking_level_select
// handlers skip it while the depth is above zero.
//
// The counter (not a boolean) survives overlapping setModel calls: the last
// in-flight switch to finish clears it, and any forced event emitted while at
// least one switch is running stays suppressed.
export async function switchModel(
  pi: ExtensionAPI,
  state: RuntimeState,
  model: Parameters<ExtensionAPI["setModel"]>[0],
): Promise<void> {
  state.modelSwitchDepth++;
  try {
    await pi.setModel(model);
  } finally {
    state.modelSwitchDepth--;
  }
}

// Propagate a model ref to every mode in the same sync group as `forMode`.
// A `thinkingLevel` on the ref overrides each mode's stored level; without
// one, per-mode levels are preserved (model changes don't clobber levels).
export function applyModelToSyncGroup(
  state: RuntimeState,
  forMode: Mode,
  ref: ModelRef,
): void {
  const bindModel = (mode: Mode): void => {
    const thinkingLevel =
      ref.thinkingLevel ?? state.modeModels[mode]?.thinkingLevel;
    state.modeModels[mode] = {
      provider: ref.provider,
      id: ref.id,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  };
  bindModel(forMode);
  if (state.syncModels.includes(forMode)) {
    for (const mode of state.syncModels) bindModel(mode);
  }
}

// Align the sync group to one model (first non-null wins) so grouped modes
// start consistent even if the config file drifted.
export function alignSyncGroup(state: RuntimeState): void {
  if (state.syncModels.length <= 1) return;
  const shared =
    state.syncModels.map((m) => state.modeModels[m]).find(Boolean) ?? null;
  if (shared) {
    for (const mode of state.syncModels) {
      const thinkingLevel = state.modeModels[mode]?.thinkingLevel;
      state.modeModels[mode] = {
        provider: shared.provider,
        id: shared.id,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      };
    }
  }
}
