/**
 * pi-run-mode
 *
 * Unified run-mode switcher: ask → plan → auto (cycle). Optional cycle
 * shortcut via pi-run-mode.json `cycleShortcut`; always available as /run-mode.
 *
 * Modes:
 * - ask (default): write/edit/patch prompt with diff preview; mutating/risky
 *   bash prompts; readonly bash allowed.
 * - plan: read-only. Only plan-file writes and read-only bash allowed; all
 *   other writes/bash are blocked until plan_approve.
 * - auto: writes and most bash run freely; risky bash prompts with Allow
 *   once / Allow session / Deny.
 *
 * Cross-mode hard-deny (~/.pi/agent/pi-run-mode.json `hardDeny`) blocks
 * sensitive paths and dangerous bash in every mode, with no prompt.
 * See permission/policy.ts.
 *
 * This entry point only bootstraps: it creates the shared runtime state and
 * wires the domain modules. The logic lives in:
 * - core/        state container, persistence, model binding
 * - modes/       setMode, optional cycle shortcut, /run-mode, indicators
 * - plan/        plan-mode lifecycle, tools, review rendering
 * - permission/  the tool_call gate, decision policy, approval prompts
 * - review/      AI bash review, model picker
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EV_NOTIFY } from "./core/events.ts";
import {
  createRuntimeState,
  loadStateFile,
  persistState,
  resolveCycleShortcut,
  restoreState,
} from "./core/state.ts";
import { MODES, type Mode } from "./core/types.ts";
import {
  alignSyncGroup,
  applyModelToSyncGroup,
} from "./core/model-binding.ts";
import { emitFooterMode, updateStatus } from "./modes/indicator.ts";
import { createSetMode, registerModeControls } from "./modes/switcher.ts";
import { registerPlanLifecycle } from "./plan/lifecycle.ts";
import { registerPlanTools } from "./plan/tools.ts";
import { registerPlanReview } from "./plan/plan-review.ts";
import { registerPermissionGate } from "./permission/gate.ts";

export default function agentModeExtension(pi: ExtensionAPI): void {
  const state = createRuntimeState();
  const setMode = createSetMode(pi, state);

  // Shortcut must be registered at load time (not session_start). Read config
  // early; changes to cycleShortcut need /reload.
  const bootConfig = loadStateFile();
  const cycleShortcut = resolveCycleShortcut(bootConfig.cycleShortcut);

  // --- Domain wiring ---
  registerModeControls(pi, state, setMode, cycleShortcut);
  registerPlanLifecycle(pi, state);
  registerPlanTools(pi, state, setMode);
  registerPlanReview(pi, state);
  registerPermissionGate(pi, state);

  // --- Session bootstrap ---
  pi.on("session_start", async (_event, ctx) => {
    state.currentCtx = ctx;
    state.currentSessionId = ctx.sessionManager.getSessionId();

    // Activate the plan-mode tools so the LLM can call them. registerTool()
    // makes tools exist; setActiveTools() makes them available to the model.
    pi.setActiveTools([
      ...new Set([...pi.getActiveTools(), "plan_start", "plan_approve"]),
    ]);

    // 1. Load cross-session config from file (lower priority than session).
    const fileState = loadStateFile();
    if (fileState.modeModels) {
      state.modeModels = { ...state.modeModels, ...fileState.modeModels };
    }
    if (Array.isArray(fileState.syncModels)) {
      state.syncModels = fileState.syncModels.filter((m): m is Mode =>
        MODES.includes(m),
      );
    }
    if (fileState.hardDeny && typeof fileState.hardDeny === "object") {
      state.hardDeny = fileState.hardDeny;
    }
    if (fileState.aiReview && typeof fileState.aiReview === "object") {
      state.aiReviewConfig = fileState.aiReview;
    }
    state.sessionAllowedBash.clear();
    state.autoAllowAiSafe = state.aiReviewConfig.autoApproval ?? false;
    alignSyncGroup(state);

    // 2. Session entries override file state (most recent wins).
    restoreState(state, ctx);

    // 3. Initialize current model reference from pi's loaded model.
    if (ctx.model) {
      state.currentModelRef = { provider: ctx.model.provider, id: ctx.model.id };
    }

    updateStatus(state);
    emitFooterMode(pi, state);

    // 4. Restore the model for the current mode, overriding pi's potentially
    //    stale default. Fallback priority: current mode > plan > auto.
    const target =
      state.modeModels[state.mode] ?? state.modeModels.plan ?? state.modeModels.auto;
    if (target) {
      const model = ctx.modelRegistry.find(target.provider, target.id);
      if (
        model &&
        (model.provider !== state.currentModelRef?.provider ||
          model.id !== state.currentModelRef?.id)
      ) {
        await pi.setModel(model);
      }
    }

    state.planPromptInjected = false;
    state.planTurnsSinceInject = 0;
    state.modeTransition = null;

    if (pi.getFlag("plan") === true) {
      await setMode("plan");
    }
  });

  // Track model changes to keep mode-model bindings in sync.
  pi.on("model_select", async (event, _ctx) => {
    state.currentModelRef = { provider: event.model.provider, id: event.model.id };
    applyModelToSyncGroup(state, state.mode, state.currentModelRef);
    persistState(pi, state);
  });

  // Notify when the agent calls ask_user_question (waiting for user input).
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "ask_user_question") return undefined;
    const input = event.input as any;
    const subtitle: string = (
      input?.questions?.[0]?.header ??
      ""
    ).slice(0, 80);
    const question: string = (input?.questions?.[0]?.question ?? "").slice(0, 200);
    const body: string = [subtitle, question].filter(Boolean).join("\n");
    pi.events.emit(EV_NOTIFY, {
      type: "question",
      title: "✋ Input Needed",
      body,
      sound: "question",
    });
    return undefined;
  });

  pi.registerFlag("plan", {
    description: "Start in plan mode",
    type: "boolean",
    default: false,
  });
}
