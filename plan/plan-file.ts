/**
 * Plan file helpers.
 *
 * In plan mode the model writes its plan to a session-scoped file under
 * `~/.pi/agent/plans/<sessionId>.md`. This is the only file write/edit allowed
 * while planning; all other writes are intercepted. Per-session isolation
 * prevents plan content from one task leaking into the next.
 *
 * Each session gets its own plan file; re-entering plan mode within the same
 * session reuses the file (model decides: continue or overwrite).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Directory holding per-session plan files. */
export const PLAN_DIR = join(homedir(), ".pi", "agent", "plans");

/** Fallback id for ephemeral (in-memory / no-session) sessions. */
const EPHEMERAL_ID = "ephemeral";

/** Absolute path of the plan file for a given session id. */
export function getPlanPath(sessionId: string | undefined): string {
  return join(PLAN_DIR, sessionId || EPHEMERAL_ID) + ".md";
}

/** Whether a plan file already exists for the given session. */
export function planExists(sessionId: string | undefined): boolean {
  return existsSync(getPlanPath(sessionId));
}

/** Read the plan file content, or null if it doesn't exist. */
export function readPlan(sessionId: string | undefined): string | null {
  const path = getPlanPath(sessionId);
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** True if `targetPath` resolves to the plan file for the given session. */
export function isPlanFile(sessionId: string | undefined, targetPath: string): boolean {
  return resolve(targetPath) === getPlanPath(sessionId);
}
