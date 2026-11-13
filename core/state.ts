/**
 * Runtime state container + persistence for pi-run-mode.
 *
 * `RuntimeState` replaces the closure variables that used to live in the
 * extension entry point, so domain modules (modes/, plan/, permission/) can
 * share one mutable state object instead of capturing a closure.
 *
 * `AgentModeState` is the persisted config-file shape (pi-run-mode.json), a
 * strict subset of the runtime state.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HardDeny } from "../permission/policy.ts";
import type { AIReviewConfig } from "../permission/ai-review.ts";
import type { BashClassifierConfig } from "../permission/bash-classifier.ts";
import { alignSyncGroup, applyModelToSyncGroup } from "./model-binding.ts";
import {
  DEFAULT_MODE,
  MODES,
  STATE_ENTRY_TYPE,
  STATE_FILE_PATH,
  THINKING_LEVELS,
  type Mode,
  type ModelRef,
  type ThinkingLevel,
} from "./types.ts";

// Persisted config-file shape (pi-run-mode.json). `modeModels` and `projects`
// are owned by the extension; the rest are user-authored config.
export type ProjectModelState = {
  enabled?: boolean;
  modeModels?: Partial<Record<Mode, ModelRef | null>>;
};

export type AgentModeState = {
  modeModels?: Record<Mode, ModelRef | null>;
  projects?: Record<string, ProjectModelState>;
  syncModels?: Mode[];
  hardDeny?: HardDeny;
  bashClassifier?: BashClassifierConfig;
  askAiReview?: AIReviewConfig;
  /** Key chord for cycling modes (e.g. "alt+m"). null/omit/"" = command only. */
  cycleShortcut?: string | null;
  /** Ordered list of active modes. First = default, determines cycle order. */
  cycleModes?: Mode[];
};

export interface RuntimeState {
  mode: Mode;
  /** Ordered list for cycling; first entry is the default startup mode. */
  cycleModes: Mode[];
  currentCtx?: ExtensionContext;
  currentSessionId?: string;
  initialized: boolean;
  projectKey?: string;
  projectEnabled: boolean;
  modeModels: Record<Mode, ModelRef | null>;
  currentModelRef: ModelRef | null;
  // Modes that share a single model (user config). When the current mode is in
  // this group, model changes propagate to the whole group.
  syncModels: Mode[];
  // Cross-mode hard-deny rules (user config), applied before mode decisions.
  hardDeny: HardDeny;
  // AI review config (provider + model for bash safety checks in ask mode).
  askAiReviewConfig: AIReviewConfig;
  // auto-mode risky-bash allowances: exact commands allowed this session only.
  sessionAllowedBash: Set<string>;
  // ask-mode: user-enabled auto-allow on AI-safe bash, this session only.
  autoAllowAiSafe: boolean;
  // Turns in plan mode since last full prompt inject (0 = not yet injected).
  planTurnsSinceInject: number;
  planPromptInjected: boolean;
  // approval result passed from tool_call handler to plan_approve execute().
  lastExitPlanApproval: "approved" | "rejected" | null;
  // user note from the approval dialog, forwarded to plan_approve execute().
  lastExitPlanNote: string | null;
  // Most recent mode transition, so before_agent_start can emit a one-shot
  // exit/reentry notice. Cleared after injection.
  modeTransition: "to_plan" | "from_plan" | null;
  // Counts in-flight setModel() calls. pi's setModel forces the default
  // thinking level (settings defaultThinkingLevel) and emits
  // thinking_level_select — that event is a forced side effect, not a user
  // choice, so handlers must ignore it while any model switch is in flight.
  // A counter (not a boolean) survives overlapping setModel calls.
  modelSwitchDepth: number;
}

export function createRuntimeState(): RuntimeState {
  return {
    mode: DEFAULT_MODE,
    cycleModes: MODES,
    initialized: false,
    projectEnabled: false,
    modeModels: { ask: null, plan: null, auto: null },
    currentModelRef: null,
    syncModels: ["ask", "auto"],
    hardDeny: {},
    askAiReviewConfig: {},
    sessionAllowedBash: new Set<string>(),
    autoAllowAiSafe: false,
    planTurnsSinceInject: 0,
    planPromptInjected: false,
    lastExitPlanApproval: null,
    lastExitPlanNote: null,
    modeTransition: null,
    modelSwitchDepth: 0,
  };
}

export function loadStateFile(strict = false): AgentModeState {
  try {
    const value = JSON.parse(readFileSync(STATE_FILE_PATH, "utf-8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected a configuration object");
    }
    return value;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}

export function saveStateFile(state: AgentModeState): void {
  // Preserve user-authored keys across writes.
  const existing = loadStateFile(true);
  const temporaryPath = `${STATE_FILE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify({ ...existing, ...state }, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, STATE_FILE_PATH);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function loadModelBindings(state: RuntimeState, config: AgentModeState): void {
  state.modeModels = {
    ask: null,
    plan: null,
    auto: null,
    ...normalizeModeModels(config.modeModels),
  };
  alignSyncGroup(state);
  const project = state.projectKey ? config.projects?.[state.projectKey] : undefined;
  state.projectEnabled = project?.enabled === true;
  if (!state.projectEnabled) return;
  const overrides = normalizeModeModels(project?.modeModels);
  for (const mode of MODES) {
    const ref = overrides[mode];
    if (ref) applyModelToSyncGroup(state, mode, ref);
    else if (ref === null) state.modeModels[mode] = null;
  }
}

export function setProjectEnabled(state: RuntimeState, enabled: boolean): boolean {
  if (!state.projectKey) return false;
  try {
    const existing = loadStateFile(true);
    saveStateFile({
      projects: {
        ...existing.projects,
        [state.projectKey]: { ...existing.projects?.[state.projectKey], enabled },
      },
    });
    return true;
  } catch {
    state.currentCtx?.ui.notify("Could not save project model settings.", "error");
    return false;
  }
}

/** Normalize config cycleShortcut: non-empty string → chord, else null (disabled). */
export function resolveCycleShortcut(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  return s.length > 0 ? s : null;
}

export function normalizeModeModels(
  value: unknown,
): Partial<Record<Mode, ModelRef | null>> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const normalized: Partial<Record<Mode, ModelRef | null>> = {};
  for (const mode of MODES) {
    const ref = source[mode];
    if (ref === null) {
      normalized[mode] = null;
      continue;
    }
    if (!ref || typeof ref !== "object") continue;
    const candidate = ref as Record<string, unknown>;
    if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") {
      continue;
    }
    const thinkingLevel = THINKING_LEVELS.includes(
      candidate.thinkingLevel as ThinkingLevel,
    )
      ? (candidate.thinkingLevel as ThinkingLevel)
      : undefined;
    normalized[mode] = {
      provider: candidate.provider,
      id: candidate.id,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }
  return normalized;
}

export function recordSessionState(pi: ExtensionAPI, state: RuntimeState): void {
  pi.appendEntry(STATE_ENTRY_TYPE, {
    mode: state.mode,
    modeModels: state.modeModels,
  });
}

export function persistState(
  pi: ExtensionAPI,
  state: RuntimeState,
  selectedMode?: Mode,
): void {
  if (!state.initialized) return;
  recordSessionState(pi, state);
  if (state.currentCtx?.mode === "rpc" || !selectedMode) return;
  try {
    const existing = loadStateFile(true);
    const project = state.projectKey ? existing.projects?.[state.projectKey] : undefined;
    state.projectEnabled = project?.enabled === true;
    const modes = state.syncModels.includes(selectedMode)
      ? state.syncModels
      : [selectedMode];
    if (state.projectEnabled && state.projectKey) {
      const modeModels = { ...project?.modeModels };
      for (const mode of modes) modeModels[mode] = state.modeModels[mode];
      saveStateFile({
        projects: {
          ...existing.projects,
          [state.projectKey]: { ...project, modeModels },
        },
      });
    } else {
      const modeModels = {
        ask: null,
        plan: null,
        auto: null,
        ...normalizeModeModels(existing.modeModels),
      };
      for (const mode of modes) modeModels[mode] = state.modeModels[mode];
      saveStateFile({ modeModels });
    }
  } catch {
    state.currentCtx?.ui.notify("Could not save model preferences.", "error");
  }
}

export function restoreState(state: RuntimeState, ctx: ExtensionContext): void {
  const entries = ctx.sessionManager.getEntries() as Array<{
    type: string;
    customType?: string;
    data?: {
      mode?: Mode;
      modeModels?: Record<Mode, ModelRef | null>;
    };
  }>;
  const entry = entries.findLast(
    (e) => e.type === "custom" && e.customType === STATE_ENTRY_TYPE,
  );
  if (entry?.data?.mode && MODES.includes(entry.data.mode)) {
    state.mode = entry.data.mode;
  }
  if (entry?.data?.modeModels) {
    const restored = normalizeModeModels(entry.data.modeModels);
    for (const mode of MODES) {
      const ref = restored[mode];
      if (ref === undefined) continue;
      if (ref === null) {
        state.modeModels[mode] = null;
        continue;
      }
      const thinkingLevel = ref.thinkingLevel ??
        state.modeModels[mode]?.thinkingLevel;
      state.modeModels[mode] = {
        provider: ref.provider,
        id: ref.id,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      };
    }
  }
}
