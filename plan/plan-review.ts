/**
 * Plan-review rendering: the plan is rendered into the chat stream as soon as
 * it's written to the plan file (not deferred to plan_approve, whose modal can
 * race with sendMessage). The rendered message is display-only and is stripped
 * from the LLM context so the model doesn't mistake it for new user input.
 */

import {
  getMarkdownTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { isPlanFile, readPlan } from "./plan-file.ts";
import type { RuntimeState } from "../core/state.ts";

export function registerPlanReview(pi: ExtensionAPI, state: RuntimeState): void {
  // The plan-review message is display-only: it lets the user read the plan
  // inline before plan_approve. It must NOT reach the LLM — convertToLlm turns
  // custom messages into role:"user" content, which the model could mistake
  // for new user input and trigger a redundant review cycle. Strip it from the
  // LLM context here. TUI rendering is unaffected (it reads session entries
  // directly, not the filtered context).
  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((m) => {
        if (m.role !== "custom") return true;
        return (m as { customType?: string }).customType !== "plan-review";
      }),
    };
  });

  // Render the plan into the chat stream as soon as it's written to the plan
  // file. Only fires for successful write/edit to this session's plan file.
  pi.on("tool_result", async (event, _ctx) => {
    if (state.mode !== "plan") return;
    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const targetPath = String(event.input?.path ?? "");
    if (!isPlanFile(state.currentSessionId, targetPath)) return;
    const content = readPlan(state.currentSessionId);
    if (!content) return;
    await pi.sendMessage({
      customType: "plan-review",
      content,
      display: true,
    });
  });

  // Always fully expand the plan content as markdown (no collapsed state) so
  // the user can review the whole plan inline when plan_approve fires.
  pi.registerMessageRenderer("plan-review", (message, _options, _theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    return new Markdown(content, 1, 1, getMarkdownTheme());
  });
}
