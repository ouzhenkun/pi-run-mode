/**
 * Plan-mode context injection (before_agent_start).
 *
 * - One-shot exit notice when leaving plan mode (approved vs unapproved).
 * - Reentry: full workflow prompt + "read existing plan first" notice.
 * - First plan turn: full workflow prompt; thereafter a sparse reminder every
 *   PLAN_PROMPT_REINJECT_EVERY turns.
 *
 * ask/auto rely on the global AGENTS.md as the default rule base and need no
 * per-turn marker.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPlanPath, planExists } from "./plan-file.ts";
import {
  buildPlanPrompt,
  buildReentryNotice,
  PLAN_PROMPT_REINJECT_EVERY,
} from "./prompt.ts";
import type { RuntimeState } from "../core/state.ts";

export function registerPlanLifecycle(pi: ExtensionAPI, state: RuntimeState): void {
  pi.on("before_agent_start", async (_event, _ctx) => {
    // One-shot exit notice when leaving plan mode. Path A (plan_approve
    // Execute) sends an "approved, switch to auto" tool_result, but that's
    // in-turn only — the next turn loses the "exited plan" anchor (weak
    // across compaction/clear). Inject an explicit exit notice mirroring
    // Claude Code's plan_mode_exit attachment so the model knows the plan-
    // mode MUST NOT constraints are lifted. Path B (manual Shift+Tab) leaves
    // an unapproved plan — warn the model not to execute it.
    if (state.modeTransition === "from_plan") {
      state.modeTransition = null;
      const approved = state.lastExitPlanApproval === "approved";
      state.lastExitPlanApproval = null;
      state.lastExitPlanNote = null;
      const planFilePath = getPlanPath(state.currentSessionId);
      if (approved) {
        return {
          message: {
            customType: "plan-mode-exit",
            content: `Exited plan mode. The plan-mode read-only constraints are lifted — you may now edit files, run tools, and execute the approved plan. The plan file is at ${planFilePath} if you need to reference it.`,
            display: false,
          },
        };
      }
      return {
        message: {
          customType: "plan-mode-exit",
          content: `Exited plan mode without approval. The plan file may contain an unfinished plan; do not execute it unless the user explicitly asks.`,
          display: false,
        },
      };
    }

    if (state.mode !== "plan") return undefined;

    // --- plan mode ---
    const planFilePath = getPlanPath(state.currentSessionId);

    // Reentry: entering plan when a plan file already exists. Inject the
    // reentry notice AND the full workflow prompt in the same turn so the
    // model has both the "read existing plan first" guidance and the complete
    // workflow (mirrors Claude Code's dual plan_mode_reentry + plan_mode
    // attachments). Without this, full prompt would be delayed to next turn.
    if (state.modeTransition === "to_plan" && planExists(state.currentSessionId)) {
      state.modeTransition = null;
      state.planPromptInjected = true;
      state.planTurnsSinceInject = 0;
      return {
        message: {
          customType: "plan-mode-reentry",
          content: `${buildReentryNotice(planFilePath)}\n\n---\n\n${buildPlanPrompt(planFilePath)}`,
          display: false,
        },
      };
    }
    state.modeTransition = null;

    // Decide inject type: first turn = full; thereafter re-inject sparse every N turns
    const shouldInjectFull = !state.planPromptInjected;
    const shouldInjectSparse =
      state.planPromptInjected &&
      state.planTurnsSinceInject >= PLAN_PROMPT_REINJECT_EVERY;

    if (shouldInjectFull) {
      state.planPromptInjected = true;
      state.planTurnsSinceInject = 0;
      return {
        message: {
          customType: "plan-mode-context",
          content: buildPlanPrompt(planFilePath),
          display: false,
        },
      };
    }

    if (shouldInjectSparse) {
      state.planTurnsSinceInject = 0;
      return {
        message: {
          customType: "plan-mode-context",
          content: `Still in plan mode. No side effects before approval (except the plan file). Write your plan to the plan file, then call plan_approve to request approval.`,
          display: false,
        },
      };
    }

    // No inject this turn — plan prompt from an earlier turn remains in history
    state.planTurnsSinceInject++;
    return undefined;
  });
}
