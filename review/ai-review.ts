/**
 * AI-powered bash command reviewer for ask mode.
 *
 * Calls the configured (or current session) model with a lightweight prompt to
 * decide whether a bash command is safe to auto-approve. Used only in ask mode;
 * auto mode uses session allowances instead, and plan mode blocks at the policy layer.
 *
 * Safety contract:
 *   - Any failure, timeout, abort, or missing auth → { decision: "review" }
 *   - The caller must treat "review" as "show human prompt", never auto-allow.
 *   - dangerous commands are already hard-blocked before reaching this layer.
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { BashKind } from "../permission/bash-classifier.ts";

export interface AIReviewConfig {
  provider?: string;
  model?: string;
  /** If true, the "Auto-allow AI-safe" checkbox defaults to checked for the session. */
  autoApproval?: boolean;
}

export interface AIReviewResult {
  decision: "safe" | "review";
  /** Short human-readable reason from the model, shown in the dialog. */
  reason: string;
}

const SYSTEM_PROMPT = `You are a coding-assistant safety reviewer. Decide if a bash command is safe to auto-approve in an interactive coding session.

SAFE = effectively read-only with no persistent side effects: commands that only inspect or print state (e.g. env, printenv, echo without redirection, ps, date, history, id, whoami, wc, stat, uname).
REVIEW = anything that modifies files, directories, git state, installs packages, runs scripts, or has any other persistent side effect — including git add/commit/push, mkdir, touch, cp, mv, npm run, etc.

When in doubt, reply REVIEW.

Reply with EXACTLY one line — no explanation beyond the reason:
SAFE:<short reason>
or
REVIEW:<short concern>`;

/**
 * Ask the AI whether `cmd` is safe to auto-approve.
 *
 * @param cmd       Raw bash command string.
 * @param bashKind  Classification from bash-classifier (mutating|risky|unknown).
 * @param ctx       ExtensionContext — provides modelRegistry and model.
 * @param config    Optional model override (provider + model id).
 * @param signal    AbortSignal — caller sets a timeout on this.
 */
export async function reviewBash(
  cmd: string,
  bashKind: BashKind,
  ctx: any,
  config: AIReviewConfig,
  signal: AbortSignal,
): Promise<AIReviewResult> {
  const FAIL: AIReviewResult = { decision: "review", reason: "" };
  try {
    // Resolve model: prefer config override, fall back to session model.
    let model = ctx.model as any;
    if (config.provider && config.model) {
      const found = ctx.modelRegistry?.find(config.provider, config.model);
      if (found) model = found;
    }
    if (!model) return FAIL;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return FAIL;

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: `Command:\n${cmd}\n\nClassification: ${bashKind}` }],
      timestamp: Date.now(),
    };

    const response = await complete(
      model,
      { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal,
        maxTokens: 40,
        onPayload: (payload: any) => {
          // Disable thinking to reduce latency.
          payload.thinking = { type: "disabled" };
          return payload;
        },
      },
    );

    if (response.stopReason === "aborted") return FAIL;

    const raw = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text as string)
      .join("")
      .trim();

    return parseAIResponse(raw);
  } catch {
    return FAIL;
  }
}

/** Parse a single-line SAFE:<reason> or REVIEW:<concern> response. */
export function parseAIResponse(raw: string): AIReviewResult {
  const upper = raw.toUpperCase();
  const colonIdx = raw.indexOf(":");
  const reason = colonIdx >= 0 ? raw.slice(colonIdx + 1).trim() : "";
  if (upper.startsWith("SAFE")) return { decision: "safe", reason };
  return { decision: "review", reason };
}
