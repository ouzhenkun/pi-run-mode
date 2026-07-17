/**
 * Centralized permission decisions for agent-mode.
 *
 * A single place that turns a tool_call into a normalized PermissionRequest,
 * applies cross-mode hard-deny rules, then resolves an action based on the
 * active mode. UI/prompting stays in index.ts; this module is pure logic.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { classifyBash, isReadOnly, type BashKind } from "./bash-classifier.ts";
import type { Mode } from "../core/types.ts";

export type { Mode };

// Cross-mode hard-deny lists. Path lists use glob-ish patterns (see matchesPath);
// bash entries are substrings/regex-source matched against the raw command.
export interface HardDeny {
  read?: string[];
  write?: string[];
  bash?: string[];
}

export type PermissionRequest =
  | { kind: "read"; path: string; absPath: string }
  | { kind: "write"; path: string; absPath: string; toolName: "write" | "edit" | "apply_patch" }
  | { kind: "bash"; command: string; bashKind: BashKind }
  | { kind: "other"; toolName: string };

export type PermissionAction =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "prompt"; prompt: "diff" | "patch" | "bash"; sessionAllow?: boolean };

// --- Path matching -----------------------------------------------------------

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * Glob-ish path match. Supports `*` (no `/`) segments and treats a bare
 * pattern as matching the basename too, so ".env" matches any-dir/.env.
 * A directory pattern (e.g. "~/.ssh") matches everything beneath it.
 */
export function matchesPath(absPath: string, pattern: string, cwd: string): boolean {
  const norm = absPath.replace(/\/+$/, "");
  let pat = expandHome(pattern);
  if (!pat.startsWith("/") && !pat.includes("*") && pat.includes("/")) {
    pat = resolve(cwd, pat); // e.g. "pi/auth.json" -> project-relative
  }

  // Bare name or glob without a slash: match against basename.
  if (!pat.includes("/")) {
    const base = norm.slice(norm.lastIndexOf("/") + 1);
    return globMatch(base, pat);
  }

  const absPat = pat.startsWith("/") ? pat.replace(/\/+$/, "") : resolve(cwd, pat).replace(/\/+$/, "");
  if (globMatch(norm, absPat)) return true;
  // Directory-prefix match: pattern is an ancestor dir of absPath.
  if (!absPat.includes("*") && (norm === absPat || norm.startsWith(absPat + "/"))) return true;
  return false;
}

function globMatch(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) return value === pattern;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(value);
}

function matchesAnyPath(absPath: string, patterns: string[] | undefined, cwd: string): boolean {
  return (patterns ?? []).some((p) => matchesPath(absPath, p, cwd));
}

function matchesBashDeny(command: string, patterns: string[] | undefined): boolean {
  return (patterns ?? []).some((p) => {
    try {
      return new RegExp(p).test(command);
    } catch {
      return command.includes(p);
    }
  });
}

// --- Request normalization ---------------------------------------------------

/** Build a PermissionRequest from tool name + input. Returns null for tools we don't gate. */
export function toPermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): PermissionRequest | null {
  if (toolName === "read") {
    const path = String(input.path ?? "");
    return { kind: "read", path, absPath: resolve(cwd, expandHome(path)) };
  }
  if (toolName === "write" || toolName === "edit") {
    const path = String(input.path ?? "");
    return { kind: "write", path, absPath: resolve(cwd, expandHome(path)), toolName };
  }
  if (toolName === "apply_patch") {
    const path = String(input.path ?? "");
    return { kind: "write", path, absPath: resolve(cwd, expandHome(path || ".")), toolName };
  }
  if (toolName === "bash") {
    const command = String(input.command ?? "");
    return { kind: "bash", command, bashKind: classifyBash(command) };
  }
  return null;
}

// --- Hard deny (cross-mode) --------------------------------------------------

/** Returns a deny action if the request violates a hard-deny rule, else null. */
export function checkHardDeny(
  req: PermissionRequest,
  hardDeny: HardDeny,
  cwd: string,
): Extract<PermissionAction, { action: "deny" }> | null {
  if (req.kind === "read" && matchesAnyPath(req.absPath, hardDeny.read, cwd)) {
    return { action: "deny", reason: `Blocked by policy: read access to "${req.path}" is denied (hardDeny.read).` };
  }
  if (req.kind === "write" && matchesAnyPath(req.absPath, hardDeny.write, cwd)) {
    return { action: "deny", reason: `Blocked by policy: write access to "${req.path}" is denied (hardDeny.write). To allow, edit hardDeny.write in pi-run-mode.json.` };
  }
  if (req.kind === "bash") {
    if (req.bashKind === "dangerous") {
      return { action: "deny", reason: `Blocked by policy: command classified as dangerous and is denied in all modes.` };
    }
    if (matchesBashDeny(req.command, hardDeny.bash)) {
      return { action: "deny", reason: `Blocked by policy: command matches hardDeny.bash.` };
    }
    // Detect sensitive-path reads in bash (e.g. cat .env, grep KEY ~/.aws/credentials).
    // Scan every path-like token in the command rather than anchoring to the
    // command name, so multi-arg commands like `grep PATTERN file` are caught too.
    // Not exhaustive — this is a guardrail, not a sandbox.
    const PATH_TOKEN = /(?:^|[\s;|&"'])([~./][^\s;|&>"']+)/g;
    let m: RegExpExecArray | null;
    while ((m = PATH_TOKEN.exec(req.command)) !== null) {
      const rawPath = m[1];
      if (!rawPath) continue;
      const absP = resolve(cwd, expandHome(rawPath));
      if (matchesAnyPath(absP, hardDeny.read, cwd)) {
        return { action: "deny", reason: `Blocked by policy: reading "${rawPath}" via bash is denied (hardDeny.read).` };
      }
    }
  }
  return null;
}

// --- Mode decision -----------------------------------------------------------

/**
 * Resolve the action for a request under a given mode, AFTER hard-deny has
 * been checked (caller runs checkHardDeny first).
 *
 * `isPlanFileWrite` tells us a write/edit targets the session plan file, the
 * only write allowed in plan mode.
 */
export function decidePermission(
  req: PermissionRequest,
  mode: Mode,
  opts: { isPlanFileWrite?: boolean } = {},
): PermissionAction {
  if (mode === "plan") return decidePlan(req, opts.isPlanFileWrite ?? false);
  if (mode === "ask") return decideAsk(req);
  return decideAuto(req);
}

function decidePlan(req: PermissionRequest, isPlanFileWrite: boolean): PermissionAction {
  switch (req.kind) {
    case "read":
      return { action: "allow" };
    case "write":
      if (isPlanFileWrite && req.toolName !== "apply_patch") return { action: "allow" };
      return { action: "deny", reason: planDeny("write") };
    case "bash":
      if (req.bashKind === "readonly") return { action: "allow" };
      return { action: "deny", reason: planDeny("bash") };
    case "other":
      return { action: "allow" };
  }
}

function decideAsk(req: PermissionRequest): PermissionAction {
  switch (req.kind) {
    case "read":
      return { action: "allow" };
    case "write":
      return { action: "prompt", prompt: req.toolName === "apply_patch" ? "patch" : "diff" };
    case "bash":
      if (req.bashKind === "readonly") return { action: "allow" };
      // mutating / risky / unknown all prompt in ask.
      return { action: "prompt", prompt: "bash" };
    case "other":
      return { action: "allow" };
  }
}

function decideAuto(req: PermissionRequest): PermissionAction {
  switch (req.kind) {
    case "read":
      return { action: "allow" };
    case "write":
      return { action: "allow" };
    case "bash":
      if (req.bashKind === "risky") return { action: "prompt", prompt: "bash", sessionAllow: true };
      return { action: "allow" };
    case "other":
      return { action: "allow" };
  }
}

function planDeny(kind: "write" | "bash"): string {
  const what = kind === "bash" ? "runs a non-read-only command" : "writes a file";
  return `Plan mode blocks this operation (it ${what}). Only read-only inspection and writing the plan file are allowed. Call plan_approve to get approval, then execute in auto/ask mode.`;
}

export { classifyBash, isReadOnly };
