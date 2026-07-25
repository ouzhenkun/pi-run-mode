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

export interface BashClassifierConfig {
  inheritDefaults?: boolean;
  dangerous?: string[];
  readonly?: string[];
  risky?: string[];
  mutating?: string[];
}

// Irreversible or remote-code-execution patterns. Always hard-blocked.
const DEFAULT_DANGEROUS: RegExp[] = [
  /(?:^|[;&|])\s*rm\s+-[a-z]*r[a-z]*f|(?:^|[;&|])\s*rm\s+-[a-z]*f[a-z]*r/, // rm -rf / -fr
  /(?:^|[;&|])\s*chmod\s+-R/,
  /(?:^|[;&|])\s*chown\s+-R/,
  /(?:^|[;&|])\s*dd\s+.*of=/,
  /(?:^|[;&|])\s*mkfs\b/,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/, // curl … | sh
  /(?:^|[;&|])\s*:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;/, // fork bomb-ish
];

// No-side-effect inspection commands. The only bash allowed in plan mode.
const DEFAULT_READONLY: RegExp[] = [
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
const DEFAULT_RISKY: RegExp[] = [
  // /(?:^|[;&|])\s*node\s+(?:-e|--eval)\b/,
  // /(?:^|[;&|])\s*(?:python|python3)\s+-c\b/,
  // /(?:^|[;&|])\s*(?:deno|bun)\s+eval\b/,
  // /(?:^|[;&|])\s*(?:npm|pnpm|yarn)\s+(?:install|i|add|ci|dlx|exec)\b/,
  // /(?:^|[;&|])\s*(?:pip|pip3)\s+install\b/,
  // /(?:^|[;&|])\s*(?:brew|apt|apt-get|dnf|pacman|port)\s+install\b/,
  // /(?:^|[;&|])\s*npx\b/,
  /(?:^|[;&|])\s*(?:sudo|eval|exec)\b/,
  /(?:^|[;&|])\s*git\s+reset\s+--hard/,
  /(?:^|[;&|])\s*git\s+clean\s+.*-[a-z]*[fd]/,
];

// Ordinary filesystem / VCS mutations.
const DEFAULT_MUTATING: RegExp[] = [
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

const RULE_KEYS = ["dangerous", "readonly", "risky", "mutating"] as const;
type RuleKey = (typeof RULE_KEYS)[number];
type ClassifierRules = Record<RuleKey, RegExp[]>;

function defaultRules(): ClassifierRules {
  return {
    dangerous: [...DEFAULT_DANGEROUS],
    readonly: [...DEFAULT_READONLY],
    risky: [...DEFAULT_RISKY],
    mutating: [...DEFAULT_MUTATING],
  };
}

let activeRules = defaultRules();

function useDefaults(reason: string): false {
  activeRules = defaultRules();
  console.warn(`[pi-run-mode] ${reason}; using built-in bash classifier rules.`);
  return false;
}

/** Apply user-authored classifier rules. Invalid configs reset to defaults. */
export function configureClassifier(config?: BashClassifierConfig): boolean {
  if (config === undefined) {
    activeRules = defaultRules();
    return true;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return useDefaults("bashClassifier must be an object");
  }

  const inheritDefaults = config.inheritDefaults ?? true;
  if (typeof inheritDefaults !== "boolean") {
    return useDefaults("bashClassifier.inheritDefaults must be a boolean");
  }

  const custom = {} as ClassifierRules;
  for (const kind of RULE_KEYS) {
    const patterns = config[kind];
    if (!inheritDefaults && patterns === undefined) {
      return useDefaults(`bashClassifier.${kind} is required when inheritDefaults is false`);
    }
    if (patterns !== undefined && (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string"))) {
      return useDefaults(`bashClassifier.${kind} must be an array of regex strings`);
    }
    try {
      custom[kind] = (patterns ?? []).map((pattern) => new RegExp(pattern));
    } catch {
      return useDefaults(`bashClassifier.${kind} contains an invalid regular expression`);
    }
  }

  if (!inheritDefaults) {
    activeRules = custom;
    return true;
  }

  const defaults = defaultRules();
  activeRules = {
    dangerous: [...defaults.dangerous, ...custom.dangerous],
    readonly: [...defaults.readonly, ...custom.readonly],
    risky: [...defaults.risky, ...custom.risky],
    mutating: [...defaults.mutating, ...custom.mutating],
  };
  return true;
}

/**
 * Classify a bash command into a risk bucket.
 * Multi-line/compound commands are matched against the whole string, so any
 * matching segment escalates the classification (dangerous wins).
 */
export function classifyBash(command: string): BashKind {
  const cmd = command ?? "";
  if (activeRules.dangerous.some((re) => re.test(cmd))) return "dangerous";
  if (isReadOnly(cmd)) return "readonly";
  if (activeRules.risky.some((re) => re.test(cmd))) return "risky";
  if (activeRules.mutating.some((re) => re.test(cmd))) return "mutating";
  return "unknown";
}

/**
 * Whether every segment of a (possibly compound) command is read-only.
 * A command like `ls && rm x` is NOT read-only because `rm x` mutates.
 */
export function isReadOnly(command: string): boolean {
  const cmd = command ?? "";
  // Reject if any dangerous/mutating/risky pattern is present anywhere.
  if (activeRules.dangerous.some((re) => re.test(cmd))) return false;
  if (activeRules.mutating.some((re) => re.test(cmd))) return false;
  if (activeRules.risky.some((re) => re.test(cmd))) return false;
  // Split on command separators; every segment must match a readonly pattern.
  const segments = cmd
    .split(/(?:&&|\|\||;)/) // bare | is NOT a separator — it appears inside quoted patterns (e.g. rg "foo|bar")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => activeRules.readonly.some((re) => re.test(seg)));
}
