/**
 * Mode↔model binding helpers. A "sync group" is a set of modes that always
 * share one model (user config); changes to any member propagate to all.
 */

import type { Mode, ModelRef } from "./types.ts";
import type { RuntimeState } from "./state.ts";

// Propagate a model ref to every mode in the same sync group as `forMode`.
export function applyModelToSyncGroup(
  state: RuntimeState,
  forMode: Mode,
  ref: ModelRef,
): void {
  const bindModel = (mode: Mode): void => {
    const thinkingLevel = state.modeModels[mode]?.thinkingLevel;
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
