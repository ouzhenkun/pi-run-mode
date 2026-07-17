/**
 * Approval-prompt UI + desktop notifications for the permission gate.
 *
 * Renders the right dialog for a "prompt" decision (diff / patch / bash) and
 * maps the user's choice to allow (undefined) or block. Notifications are
 * deferred to the dialog's onWaitApprove hook so they only fire when the user
 * actually has to wait (not when AI review auto-approves).
 */

import { basename, dirname } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { EV_NOTIFY } from "../core/events.ts";
import type { RuntimeState } from "../core/state.ts";
import { reviewBash } from "../review/ai-review.ts";
import { approveDialog } from "./approve-dialog.ts";
import type { PermissionRequest } from "./policy.ts";

export type PromptDecision = {
  prompt: "diff" | "patch" | "bash";
  sessionAllow?: boolean;
};

export function blockWithFeedback(note: string): { block: true; reason: string } {
  const reason = note.trim()
    ? `Blocked by user: ${note.trim()}`
    : "Blocked by user";
  return { block: true, reason };
}

export async function runPermissionPrompt(
  pi: ExtensionAPI,
  state: RuntimeState,
  event: { toolName: string; input: unknown },
  req: PermissionRequest,
  decision: PromptDecision,
  ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
  const input = event.input as Record<string, any>;

  if (decision.prompt === "diff" && req.kind === "write") {
    const filePath = req.path;
    const result = await approveDialog(ctx, {
      title: `${event.toolName}`,
      body: filePath,
      items: [
        { value: "allow", label: "Allow" },
        { value: "deny", label: "Deny" },
      ],
      onWaitApprove: () => {
        pi.events.emit(EV_NOTIFY, {
          type: "review",
          title: "✏️ Approval Needed",
          body: dirname(filePath) !== "." ? dirname(filePath) : "",
          sound: "question",
        });
      },
    });
    if (result?.value === "allow") return undefined;
    return blockWithFeedback(result?.note ?? "");
  }

  if (decision.prompt === "patch") {
    const patch = String(input.patch ?? input.diff ?? JSON.stringify(input)).slice(0, 2000);
    const result = await approveDialog(ctx, {
      title: "apply_patch",
      body: patch,
      items: [
        { value: "allow", label: "Allow" },
        { value: "deny", label: "Deny" },
      ],
      maxBodyLines: 16,
      onWaitApprove: () => {
        pi.events.emit(EV_NOTIFY, {
          type: "review",
          title: "📎️ Approval Needed",
          body: extractPatchFiles(patch),
          sound: "question",
        });
      },
    });
    if (result?.value === "allow") return undefined;
    return blockWithFeedback(result?.note ?? "");
  }

  // bash prompt
  if (req.kind === "bash") {
    const cmd = req.command;
    const preview = cmd.length > 500 ? cmd.slice(0, 500) + "\n..." : cmd;

    // auto risky bash (auto mode): session allowance UI, no AI review.
    if (decision.sessionAllow) {
      const result = await approveDialog(ctx, {
        title: `bash (${req.bashKind})`,
        body: `${preview}\n\nAllow session = same command only, until reload/restart`,
        items: [
          { value: "once", label: "Allow once" },
          { value: "session", label: "Allow session" },
          { value: "deny", label: "Deny" },
        ],
        onWaitApprove: () => {
          pi.events.emit(EV_NOTIFY, {
            type: "review",
            title: "🔧️ Approval Needed",
            body: "$ " + (cmd.split("\n")[0] ?? "").slice(0, 78),
            sound: "question",
          });
        },
      });
      if (result?.value === "once") return undefined;
      if (result?.value === "session") { state.sessionAllowedBash.add(cmd); return undefined; }
      return blockWithFeedback(result?.note ?? "");
    }

    // ask mode: show the human prompt immediately; AI review is advisory only.
    const result = await approveDialog(ctx, {
      title: `bash (${req.bashKind})`,
      body: preview,
      items: [
        { value: "allow", label: "Allow" },
        { value: "deny", label: "Deny" },
      ],
      runReview: (signal) => reviewBash(cmd, req.bashKind, ctx, state.aiReviewConfig, signal),
      autoAllowInitial: state.autoAllowAiSafe,
      onAutoAllowChange: (v) => { state.autoAllowAiSafe = v; },
      onWaitApprove: () => {
        pi.events.emit(EV_NOTIFY, {
            type: "review",
            title: "🔧️ Approval Needed",
            body: "$ " + (cmd.split("\n")[0] ?? "").slice(0, 78),
            sound: "question",
        });
      },
    });
    if (result?.value === "allow") {
      if (result.auto) {
        const reason = result.autoReason?.trim() ? `${result.autoReason}` : "";
        const cmdLine = (cmd.split("\n")[0] ?? cmd).slice(0, 80);
        ctx.ui.notify(`${ctx.ui.theme.fg("syntaxType", "Auto-approved")}\n${ctx.ui.theme.fg("dim", `\u2713 ${reason}\n> ${cmdLine}`)}`, "info");
      }
      return undefined;
    }
    return blockWithFeedback(result?.note ?? "");
  }

  return undefined;
}

function extractPatchFiles(patch: string): string {
  const matches = [...patch.matchAll(/^\+{3}\s+(?:b\/)?([\S]+)/gm)];
  if (matches.length === 0) return "patch";
  const files = matches.map((m) => basename(m[1])).filter(Boolean);
  if (files.length === 0) return "patch";
  if (files.length === 1) return files[0];
  if (files.length === 2) return `${files[0]}, ${files[1]}`;
  return `${files[0]}, ${files[1]} +${files.length - 2} more`;
}
