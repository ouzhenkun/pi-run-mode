/**
 * Plan-mode tools (model-driven entry/exit) + the plan-approval dialog.
 *
 * - plan_start: enter plan mode (read-only transition, no confirmation).
 * - plan_approve: request approval; the tool_call handler shows the modal
 *   Execute / Execute with… / Stay dialog and records the outcome, which the
 *   tool's execute() reports back to the model in-turn.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EV_MODAL, EV_NOTIFY } from "../core/events.ts";
import type { RuntimeState } from "../core/state.ts";
import type { SetMode } from "../core/types.ts";
import { approveDialog } from "../permission/approve-dialog.ts";
import { pickModel } from "../review/model-picker.ts";
import { getPlanPath, planExists, readPlan } from "./plan-file.ts";
import { buildPlanPrompt, buildReentryNotice } from "./prompt.ts";

const STAY_LABEL = "Stay in plan mode";
const EXECUTE_LABEL = "Execute";
const EXECUTE_WITH_LABEL = "Execute with…";

export function registerPlanTools(
  pi: ExtensionAPI,
  state: RuntimeState,
  setMode: SetMode,
): void {
  function getExecuteLabel(): string {
    const ref = state.modeModels.auto ?? state.currentModelRef;
    return ref ? `${EXECUTE_LABEL} (${ref.provider}/${ref.id})` : EXECUTE_LABEL;
  }

  // Handle plan mode entry/exit tools (called by the model)
  pi.on("tool_call", async (event, ctx) => {
    // --- plan_start ---
    // No confirmation: entering plan mode is a read-only transition (stricter
    // than ask/auto), so it's safe to let the model decide. A non-blocking
    // notify keeps the user informed without interrupting the flow. The
    // prompt + description gate over-use ("non-trivial tasks only").
    if (event.toolName === "plan_start") {
      const reason = String((event.input as any)?.reason ?? "");
      if (ctx.hasUI) {
        ctx.ui.notify(
          reason ? `Entered plan mode: ${reason}` : "Entered plan mode.",
          "info",
        );
      }
      await setMode("plan");
      return undefined; // allow execute to return success message
    }

    // --- plan_approve ---
    if (event.toolName === "plan_approve") {
      if (state.mode !== "plan") {
        return {
          block: true,
          reason:
            "Not in plan mode; this tool cannot be called. If the plan was already approved, continue implementing.",
        };
      }
      if (!ctx.hasUI) return undefined;
      const input = event.input as any;
      // Plan content is rendered at write time (tool_result handler), not
      // here — the modal dialog can race with sendMessage rendering.
      const planFileContent = readPlan(state.currentSessionId);
      const planSummary = String(input?.plan_summary ?? "");
      const files: string[] = Array.isArray(input?.files) ? input.files : [];
      const validation = String(input?.validation ?? "");
      const bodyParts = [
        planFileContent
          ? planFileContent.slice(0, 200)
          : planSummary.slice(0, 120),
        files.length ? `files: ${files.join(", ").slice(0, 100)}` : "",
        validation ? `validation: ${validation.slice(0, 80)}` : "",
      ].filter(Boolean);
      const executeLabel = getExecuteLabel();
      ctx.ui.setWorkingVisible(false);
      pi.events.emit(EV_MODAL, { phase: "open" });
      const planResult = await approveDialog(ctx, {
        title: "Plan ready",
        items: [
          { value: "execute", label: executeLabel },
          { value: "execute_with", label: EXECUTE_WITH_LABEL },
          { value: "stay", label: STAY_LABEL },
        ],
        onWaitApprove: () => {
          pi.events.emit(EV_NOTIFY, {
            type: "plan-ready",
            title: "📋 Plan Ready",
            body:
              bodyParts.join("\n").slice(0, 300) || "Execute or stay in plan mode?",
            sound: "plan-ready",
          });
        },
      });
      pi.events.emit(EV_MODAL, { phase: "close" });
      ctx.ui.setWorkingVisible(true);

      if (!planResult) {
        state.lastExitPlanApproval = "rejected";
        return undefined;
      }
      const { value: planChoice, note: planNote } = planResult;
      // The execution trigger, the "ignore discarded approaches" nudge, and any
      // user note all reach the model in-turn via the plan_approve tool result.
      // No followUp is sent: it would only drain on the next user turn, arriving
      // too late (after plan execution for "execute", or mid-revision for "stay").
      state.lastExitPlanNote = planNote || null;

      if (planChoice === "execute") {
        state.lastExitPlanApproval = "approved";
        await setMode("auto");
        ctx.ui.notify("Executing plan.", "info");
        return undefined;
      }
      if (planChoice === "execute_with") {
        const models = ctx.modelRegistry.getAvailable();
        if (models.length === 0) {
          ctx.ui.notify("No available models.", "warning");
          state.lastExitPlanApproval = "rejected";
          return undefined;
        }
        const picked = await pickModel(ctx, models);
        if (picked) {
          const model = ctx.modelRegistry.find(picked.provider, picked.id);
          state.lastExitPlanApproval = "approved";
          await setMode("auto");
          if (model) await pi.setModel(model);
          ctx.ui.notify(
            `Executing with ${picked.provider}/${picked.id}.`,
            "info",
          );
          return undefined;
        }
        state.lastExitPlanApproval = "rejected";
        return undefined;
      }
      // stay
      state.lastExitPlanApproval = "rejected";
      return undefined;
    }

    return undefined;
  });

  // --- Plan mode tools (model-driven entry/exit) ---

  pi.registerTool({
    name: "plan_start",
    label: "Enter Plan Mode",
    description:
      "Call this tool proactively when the task is non-trivial (multi-file changes, architectural decisions, unclear requirements, multiple viable approaches) to request entering plan mode and plan before executing. Do not call for simple tasks (single-line fixes, explicit instructions, small tweaks) or pure research/exploration tasks.",
    parameters: Type.Object({
      reason: Type.String({
        description: "Why this task needs planning first",
      }),
    }),
    async execute() {
      const planFilePath = getPlanPath(state.currentSessionId);
      // Same-turn injection via sendMessage so the model gets the workflow
      // prompt in the turn it called plan_start (before_agent_start only
      // fires next turn). Handle reentry (plan file already exists) the same
      // way as the manual Shift+Tab path: notice + full prompt together.
      const reentry = planExists(state.currentSessionId);
      const content = reentry
        ? `${buildReentryNotice(planFilePath)}\n\n---\n\n${buildPlanPrompt(planFilePath)}`
        : buildPlanPrompt(planFilePath);
      await pi.sendMessage({
        customType: reentry ? "plan-mode-reentry" : "plan-mode-context",
        content,
        display: false,
      });
      // Consume the transition signal set by setMode("plan"): injection was
      // already done here, so before_agent_start must skip its inject logic
      // next turn. Without this, before_agent_start would re-fire the
      // reentry branch (resetting planPromptInjected) and double-inject.
      state.modeTransition = null;
      state.planPromptInjected = true;
      state.planTurnsSinceInject = 0;
      return {
        content: [
          {
            type: "text",
            text: `Entered plan mode. Plan file: ${planFilePath}.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "plan_approve",
    label: "Exit Plan Mode",
    description:
      "Call this only in plan mode, after the plan is complete, to request user approval and exit plan mode. Do not call for research/exploration tasks. calling this tool is the approval request.",
    parameters: Type.Object({
      plan_summary: Type.String({ description: "Plan summary" }),
      files: Type.Array(Type.String(), {
        description: "Files expected to change",
      }),
      validation: Type.String({ description: "Validation commands" }),
    }),
    async execute() {
      const status = state.lastExitPlanApproval;
      const note = state.lastExitPlanNote;
      state.lastExitPlanNote = null;
      if (status === "approved") {
        const text =
          `Plan approved. ${note ? `User feedback: ${note}` : ''}\nYou can now start coding. The plan file is at ${getPlanPath(state.currentSessionId)} — read it if you need to reference the plan during implementation.`;
        return { content: [{ type: "text", text }], details: {} };
      }
      if (status === "rejected") {
        const text = note
          ? `Plan not approved. User feedback: ${note}`
          : "Plan not approved. Revise the plan and request approval again.";
        return { content: [{ type: "text", text }], details: {} };
      }
      return { content: [{ type: "text", text: "Awaiting approval." }], details: {} };
    },
  });
}
