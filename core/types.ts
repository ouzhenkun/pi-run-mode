/**
 * Foundational types and constants for agent-mode. Zero business-logic deps:
 * every other module may import from here, but this file imports from none of
 * them.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type Mode = "ask" | "plan" | "auto";
export const MODES: Mode[] = ["ask", "plan", "auto"];
export const DEFAULT_MODE: Mode = "ask";

export type ModelRef = { provider: string; id: string };

// A mode switch. Defined here so plan/ and modes/ share it without coupling.
export type SetMode = (newMode: Mode) => Promise<void>;

export const STATE_ENTRY_TYPE = "agent-mode-state";
export const STATE_FILE_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "agent-mode.json",
);
