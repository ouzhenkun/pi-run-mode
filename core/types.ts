/**
 * Foundational types and constants for pi-run-mode. Zero business-logic deps:
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

// Session log customType — kept stable so old sessions still restore mode.
export const STATE_ENTRY_TYPE = "agent-mode-state";

const AGENT_DIR = join(homedir(), ".pi", "agent");
export const STATE_FILE_PATH = join(AGENT_DIR, "pi-run-mode.json");
// Pre-extract filename; loadStateFile migrates once then removes it.
export const LEGACY_STATE_FILE_PATH = join(AGENT_DIR, "agent-mode.json");
