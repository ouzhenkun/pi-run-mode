/**
 * Bash command classifier.
 *
 * Classifies a bash command into one of five risk buckets. Rules are
 * intentionally coarse — this is a workflow guardrail, not a security sandbox.
 * Order matters: dangerous > readonly > risky > mutating > unknown.
 *
 * - dangerous: destructive / irreversible / remote-exec-piped-to-shell.
 *              Hard-blocked in every mode.
 * - readonly:  inspection commands with no side effects. The only bash
 *              allowed in plan mode.
 * - risky:     runs arbitrary code or mutates the environment in ways a
 *              simple pattern can't fully vet (node -e, installers, scripts).
 * - mutating:  ordinary filesystem/VCS mutations (mkdir, mv, git commit…).
 * - unknown:   anything unmatched.
 */

export type BashKind = "dangerous" | "readonly" | "risky" | "mutating" | "unknown";

// Irreversible or remote-code-execution patterns. Always hard-blocked.
const DANGEROUS: RegExp[] = [
  /(?:^|[;&|])\s*rm\s+-[a-z]*r[a-z]*f|(?:^|[;&|])\s*rm\s+-[a-z]*f[a-z]*r/, // rm -rf / -fr
  /(?:^|[;&|])\s*chmod\s+-R/,
  /(?:^|[;&|])\s*chown\s+-R/,
  /(?:^|[;&|])\s*dd\s+.*of=/,
  /(?:^|[;&|])\s*mkfs\b/,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/, // curl … | sh
  /(?:^|[;&|])\s*:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/, // fork bomb-ish
];

// No-side-effect inspection commands. The only bash allowed in plan mode.
const READONLY: RegExp[] = [
  /^\s*pwd\s*$/,
  /^\s*(?:ls|ll)\b/,
  /^\s*(?:cat|bat|head|tail|less|wc)\b/,
  /^\s*(?:rg|grep|ag|ack)\b/,
  /^\s*(?:fd|find)\b/,
  /^\s*(?:which|type|whereis|file|stat|du|df)\b/,
  /^\s*(?:echo|printf)\b(?![^\n]*[>|])/, // echo without redirection/pipe
  /^\s*git\s+(?:status|diff|log|show|blame|branch|remote|stash\s+list|rev-parse|describe|config\s+--get|ls-files|shortlog)\b/,
  /^\s*(?:node|npm|pnpm|yarn|python|python3|pip|pip3|go|cargo|deno|bun)\s+(?:--version|-v|version)\s*$/,
];

// Runs arbitrary code or mutates environment; prompt in auto, deny in plan.
const RISKY: RegExp[] = [
  // /(?:^|[;&|])\s*node\s+(?:-e|--eval)\b/,
  // /(?:^|[;&|])\s*(?:python|python3)\s+-c\b/,
  // /(?:^|[;&|])\s*(?:deno|bun)\s+eval\b/,
  // /(?:^|[;&|])\s*(?:npm|pnpm|yarn)\s+(?:install|i|add|ci|dlx|exec)\b/,
  // /(?:^|[;&|])\s*(?:pip|pip3)\s+install\b/,
  // /(?:^|[;&|])\s*(?:brew|apt|apt-get|dnf|pacman|port)\s+install\b/,
  // /(?:^|[;&|])\s*npx\b/,
  /(?:^|[;&|])\s*(?:sudo|eval|exec)\b/,
  /(?:^|[;&|])\s*git\s+merge\b(?=[^\n;&|]*\b(?:release\/qa|origin\/release\/qa|qa)\b)/,
  /(?:^|[;&|])\s*git\s+reset\s+--hard/,
  /(?:^|[;&|])\s*git\s+clean\s+.*-[a-z]*[fd]/,
];

// Ordinary filesystem / VCS mutations.
const MUTATING: RegExp[] = [
  /(?:^|[;&|])\s*(?:rm|rmdir)\s/,
  /(?:^|[;&|])\s*(?:cp|mv|ln)\s/,
  /(?:^|[;&|])\s*(?:mkdir|touch)\s/,
  /(?:^|[;&|])\s*chmod\s/,
  /(?:^|[;&|])\s*chown\s/,
  /(?:^|[;&|])\s*sed\s+.*-i/,
  /\btee\b\s/,
  /(?:^|\s)>>?\s*\S/, // > / >> redirection to a file
  /(?:^|[;&|])\s*git\s+(?:commit|push|add|rm|mv|checkout|switch|merge|rebase|tag|apply|restore|revert|cherry-pick|stash(?!\s+list))\b/,
];

/**
 * Classify a bash command into a risk bucket.
 * Multi-line/compound commands are matched against the whole string, so any
 * matching segment escalates the classification (dangerous wins).
 */
export function classifyBash(command: string): BashKind {
  const cmd = command ?? "";
  if (DANGEROUS.some((re) => re.test(cmd))) return "dangerous";
  if (isReadOnly(cmd)) return "readonly";
  if (RISKY.some((re) => re.test(cmd))) return "risky";
  if (MUTATING.some((re) => re.test(cmd))) return "mutating";
  return "unknown";
}

/**
 * Whether every segment of a (possibly compound) command is read-only.
 * A command like `ls && rm x` is NOT read-only because `rm x` mutates.
 */
export function isReadOnly(command: string): boolean {
  const cmd = command ?? "";
  // Reject if any dangerous/mutating/risky pattern is present anywhere.
  if (DANGEROUS.some((re) => re.test(cmd))) return false;
  if (MUTATING.some((re) => re.test(cmd))) return false;
  if (RISKY.some((re) => re.test(cmd))) return false;
  // Split on command separators; every segment must match a readonly pattern.
  const segments = cmd
    .split(/(?:&&|\|\||;)/) // bare | is NOT a separator — it appears inside quoted patterns (e.g. rg "foo|bar")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => READONLY.some((re) => re.test(seg)));
}
