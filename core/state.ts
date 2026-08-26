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

import { readFileSync, writeFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { HardDeny } from "../permission/policy.ts";
import type { AIReviewConfig } from "../permission/ai-review.ts";
import type { BashClassifierConfig } from "../permission/bash-classifier.ts";
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

// Persisted config-file shape (pi-run-mode.json). `modeModels` is owned by the
// extension; the rest are user-authored config.
export type AgentModeState = {
  modeModels?: Record<Mode, ModelRef | null>;
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

export function loadStateFile(): AgentModeState {
  try {
    return JSON.parse(readFileSync(STATE_FILE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveStateFile(state: AgentModeState): void {
  try {
    // Preserve user-authored keys across writes.
    const existing = loadStateFile();
    const merged: AgentModeState = { ...state };
    if (existing.syncModels) merged.syncModels = existing.syncModels;
    if (existing.hardDeny) merged.hardDeny = existing.hardDeny;
    if (existing.bashClassifier) merged.bashClassifier = existing.bashClassifier;
    if (existing.askAiReview) merged.askAiReview = existing.askAiReview;
    if (existing.cycleShortcut !== undefined) {
      merged.cycleShortcut = existing.cycleShortcut;
    }
    if (Array.isArray(existing.cycleModes) && existing.cycleModes.length > 0) {
      merged.cycleModes = existing.cycleModes;
    }
    writeFileSync(STATE_FILE_PATH, JSON.stringify(merged, null, 2));
  } catch {} // best-effort
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

export function persistState(pi: ExtensionAPI, state: RuntimeState): void {
  pi.appendEntry(STATE_ENTRY_TYPE, {
    mode: state.mode,
    modeModels: state.modeModels,
  });
  saveStateFile({ modeModels: state.modeModels });
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
