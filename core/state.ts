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
import type { AIReviewConfig } from "../review/ai-review.ts";
import {
  DEFAULT_MODE,
  MODES,
  STATE_ENTRY_TYPE,
  STATE_FILE_PATH,
  type Mode,
  type ModelRef,
} from "./types.ts";

// Persisted config-file shape (pi-run-mode.json). `modeModels` is owned by the
// extension; `syncModels`/`hardDeny`/`aiReview` are user-authored config.
export type AgentModeState = {
  modeModels?: Record<Mode, ModelRef | null>;
  syncModels?: Mode[];
  hardDeny?: HardDeny;
  aiReview?: AIReviewConfig;
};

export interface RuntimeState {
  mode: Mode;
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
  aiReviewConfig: AIReviewConfig;
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
}

export function createRuntimeState(): RuntimeState {
  return {
    mode: DEFAULT_MODE,
    modeModels: { ask: null, plan: null, auto: null },
    currentModelRef: null,
    syncModels: ["ask", "auto"],
    hardDeny: {},
    aiReviewConfig: {},
    sessionAllowedBash: new Set<string>(),
    autoAllowAiSafe: false,
    planTurnsSinceInject: 0,
    planPromptInjected: false,
    lastExitPlanApproval: null,
    lastExitPlanNote: null,
    modeTransition: null,
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
    // Preserve user-provided config (syncModels, hardDeny, aiReview) across
    // writes — this owns modeModels only; the rest is user-authored.
    const existing = loadStateFile();
    const merged: AgentModeState = { ...state };
    if (existing.syncModels) merged.syncModels = existing.syncModels;
    if (existing.hardDeny) merged.hardDeny = existing.hardDeny;
    if (existing.aiReview) merged.aiReview = existing.aiReview;
    writeFileSync(STATE_FILE_PATH, JSON.stringify(merged, null, 2));
  } catch {} // best-effort
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
    data?: { mode?: Mode; modeModels?: Record<Mode, ModelRef | null> };
  }>;
  const entry = entries.findLast(
    (e) => e.type === "custom" && e.customType === STATE_ENTRY_TYPE,
  );
  if (entry?.data?.mode && MODES.includes(entry.data.mode)) {
    state.mode = entry.data.mode;
  }
  if (entry?.data?.modeModels) {
    state.modeModels = { ...state.modeModels, ...entry.data.modeModels };
  }
}
