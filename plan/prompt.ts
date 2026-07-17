/**
 * Plan-mode workflow prompt construction. The base prompt is bundled alongside
 * this module as plan-mode.md; helpers append the per-session plan-file path.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, "plan-mode.md");

// Plan mode workflow prompt (bundled alongside this module).
const planPrompt = readFileSync(PROMPT_PATH, "utf-8").trim();

// Re-inject plan prompt every N turns (after the first full inject),
// mirroring Claude Code's attachment throttle to save tokens.
export const PLAN_PROMPT_REINJECT_EVERY = 5;

// Full plan-mode workflow prompt with the plan-file footer appended.
// Single source for all injection paths (before_agent_start + plan_start).
export function buildPlanPrompt(planFilePath: string): string {
  return (
    planPrompt +
    `\n\n## Plan File\nWrite your plan to the plan file (absolute path: ${planFilePath}).`
  );
}

// Guidance shown when re-entering plan mode and a plan file already exists.
export function buildReentryNotice(planFilePath: string): string {
  return `Re-entering plan mode. A plan file for this session already exists (${planFilePath}). Read it first and decide whether it applies to the current request: incrementally revise if it's a continuation of the same task, or overwrite if it's a new task.`;
}
