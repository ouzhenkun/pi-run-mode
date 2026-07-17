/**
 * Centralized permission gate (ask / plan / auto).
 *
 * Single tool_call entry: normalize the call, apply cross-mode hard-deny,
 * then resolve a mode-specific action (allow / deny / prompt). Decision logic
 * lives in policy.ts; prompt UI lives in prompts.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  toPermissionRequest,
  checkHardDeny,
  decidePermission,
} from "./policy.ts";
import { isPlanFile } from "../plan/plan-file.ts";
import { runPermissionPrompt } from "./prompts.ts";
import type { RuntimeState } from "../core/state.ts";

export function registerPermissionGate(pi: ExtensionAPI, state: RuntimeState): void {
  pi.on("tool_call", async (event, ctx) => {
    const req = toPermissionRequest(
      event.toolName,
      event.input as Record<string, unknown>,
      ctx.cwd,
    );
    if (!req) return undefined; // not a gated tool

    // 1. Cross-mode hard deny (dangerous bash, sensitive paths). No prompt.
    const denied = checkHardDeny(req, state.hardDeny, ctx.cwd);
    if (denied) {
      if (ctx.hasUI) ctx.ui.notify(denied.reason, "warning");
      return { block: true, reason: denied.reason };
    }

    // 2. Mode decision. Plan file writes are the one exception in plan mode.
    const isPlanFileWrite =
      req.kind === "write" && isPlanFile(state.currentSessionId, req.path);
    const decision = decidePermission(req, state.mode, { isPlanFileWrite });

    if (decision.action === "allow") return undefined;
    if (decision.action === "deny") {
      return { block: true, reason: decision.reason };
    }

    // Session allowance: auto risky bash already approved for this session.
    if (
      decision.sessionAllow &&
      req.kind === "bash" &&
      state.sessionAllowedBash.has(req.command)
    ) {
      return undefined;
    }

    // 3. Prompt (only reached in ask, or auto risky bash). Subagent/headless
    //    sessions have no UI to confirm a prompt. Re-decide under auto rules:
    //    mutating writes/bash (incl. unknown) pass; risky/dangerous still
    //    prompt -> block (hardDeny already applied in step 1). Lets
    //    write-capable subagents (e.g. a git "pusher") run without weakening
    //    the interactive ask-mode gate.
    if (!ctx.hasUI) {
      const autoDecision = decidePermission(req, "auto", { isPlanFileWrite });
      if (autoDecision.action === "allow") return undefined;
      return {
        block: true,
        reason: "Approval required but no interactive UI available; auto-rules would prompt.",
      };
    }
    return runPermissionPrompt(pi, state, event, req, decision, ctx);
  });
}
