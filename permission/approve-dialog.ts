/**
 * ApproveDialog — shared approval prompt with optional advisory AI review
 * and optional session-scoped auto-allow-on-AI-safe.
 *
 * Used by every agent-mode permission prompt (diff / patch / bash ask /
 * bash session) and by plan_approve. The dialog opens immediately. When
 * `runReview` is provided, the AI verdict updates in place. The optional
 * "Auto-allow AI-safe" checkbox (Allow row) starts a 3s countdown after AI
 * returns safe — any key cancels it (no restart). The user's explicit
 * Allow/Deny is always authoritative.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  Key,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AIReviewResult } from "../review/ai-review.ts";
import { withModal } from "../core/modal.ts";

export interface ApproveDialogItem {
  value: string;
  label: string;
  description?: string;
}

export type ApproveDialogResult = { value: string; note: string; auto?: boolean; autoReason?: string } | null;

export interface ApproveDialogOptions {
  title: string;
  /** Optional pre-formatted body text (command, patch, etc). Wrapped + capped. */
  body?: string;
  items: ApproveDialogItem[];
  /** If provided, an "AI review: ..." line renders and updates async. */
  runReview?: (signal: AbortSignal) => Promise<AIReviewResult>;
  timeoutMs?: number;
  maxBodyLines?: number;
  /** Initial checkbox state (session flag owned by caller). Bash ask only. */
  autoAllowInitial?: boolean;
  /** Notified on every checkbox toggle, so the caller can persist the flag. */
  onAutoAllowChange?: (v: boolean) => void;
  onWaitApprove?: (review?: AIReviewResult) => void;
}

type AIState =
  | { status: "pending" }
  | { status: "safe"; reason: string }
  | { status: "review"; reason: string }
  | { status: "failed"; reason: string };

const NOTE_LABEL = " Note: ";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BODY_LINES = 8;
const COUNTDOWN_SECONDS = 3;
const AUTO_LABEL = "Auto-allow AI-safe this session";

class ApproveDialog {
  private readonly input: Input;
  private focusArea: "list" | "input" = "list";
  private _focused = false;
  private selectedIndex = 0;
  private aiState: AIState = { status: "pending" };
  private closed = false;
  private abortController: AbortController | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private autoAllow: boolean;
  private countdownActive = false;
  private countdownCancelled = false;
  private countdownRemaining = 0;
  private countdownInterval: ReturnType<typeof setInterval> | null = null;
  private hasFiredWait = false;

  constructor(
    private readonly options: ApproveDialogOptions,
    private readonly theme: any,
    private readonly tui: any,
    private readonly done: (result: ApproveDialogResult) => void,
  ) {
    this.input = new Input();
    this.input.onEscape = () => {
      this.focusArea = "list";
      this.input.focused = false;
      this.tui.requestRender();
    };
    this.autoAllow = !!options.autoAllowInitial;
    if (options.runReview) this.startReview();
    else this.fireWaitApprove();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(v: boolean) {
    this._focused = v;
    this.input.focused = v && this.focusArea === "input";
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    // Any keypress cancels an active countdown (no restart for this command).
    if (this.countdownActive) this.cancelCountdown();

    if (matchesKey(data, Key.tab)) {
      this.focusArea = this.focusArea === "list" ? "input" : "list";
      this.input.focused = this._focused && this.focusArea === "input";
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.focusArea === "input") {
        this.submit();
        return;
      }
      // Checkbox row → toggle (not submit).
      if (this.options.runReview && this.selectedIndex === this.options.items.length) {
        this.autoAllow = !this.autoAllow;
        this.options.onAutoAllowChange?.(this.autoAllow);
        this.tui.requestRender();
        this.maybeStartCountdown();
        return;
      }
      const item = this.options.items[this.selectedIndex];
      if (!item) return;
      // Deny with empty note → divert to note input for optional feedback.
      if (item.value === "deny" && this.input.getValue().trim() === "") {
        this.focusArea = "input";
        this.input.focused = this._focused && this.focusArea === "input";
        this.tui.requestRender();
        return;
      }
      this.submit();
      return;
    }

    if (this.focusArea === "input") {
      this.input.handleInput(data);
      this.tui.requestRender();
      return;
    }

    // list focus
    if (matchesKey(data, Key.up)) {
      if (this.selectedIndex > 0) { this.selectedIndex--; this.tui.requestRender(); }
      return;
    }
    if (matchesKey(data, Key.down)) {
      const max = this.options.runReview ? this.options.items.length : this.options.items.length - 1;
      if (this.selectedIndex < max) { this.selectedIndex++; this.tui.requestRender(); }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.finish(null);
      return;
    }
    // Space toggles the auto-allow checkbox (only on the checkbox row).
    if (
      this.options.runReview &&
      this.selectedIndex === this.options.items.length &&
      matchesKey(data, Key.space)
    ) {
      this.autoAllow = !this.autoAllow;
      this.options.onAutoAllowChange?.(this.autoAllow);
      this.tui.requestRender();
      this.maybeStartCountdown();
      return;
    }
    // Other keys ignored (no list filtering for 2-3 items).
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];

    lines.push(t.fg("accent", "─".repeat(width)));
    lines.push(` ${t.fg("accent", t.bold(this.options.title))}`);

    const bodyLines = this.options.body ? this.renderBody(width) : [];
    if (bodyLines.length) {
      lines.push("");
      lines.push(...bodyLines);
    }

    lines.push("");
    lines.push(...this.renderList(width));

    if (this.options.runReview) {
      lines.push(this.renderAI(width));
    }

    lines.push("");

    if (this.focusArea === "input") {
      const inputWidth = Math.max(1, width - NOTE_LABEL.length);
      const inputLines = this.input.render(inputWidth);
      lines.push(t.fg("accent", NOTE_LABEL) + (inputLines[0] ?? ""));
    } else {
      const value = this.input.getValue();
      const display = value !== "" ? value : t.fg("dim", "(tab to add note)");
      lines.push(t.fg("dim", NOTE_LABEL) + display);
    }

    const helpText = this.focusArea === "list"
      ? "↑↓ select  tab note  ↵ ok  esc cancel"
      : "type note  tab back  ↵ ok  esc back";
    lines.push("");
    lines.push(` ${t.fg("dim", helpText)}`);
    lines.push(t.fg("accent", "─".repeat(width)));

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderList(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];

    for (let i = 0; i < this.options.items.length; i++) {
      const item = this.options.items[i];
      const selected = i === this.selectedIndex;
      const prefix = selected ? t.fg("accent", "▸ ") : "  ";
      const labelColor = selected ? "accent" : "text";
      let text = t.fg(labelColor, item.label);
      if (item.description) {
        text = `${text}  ${t.fg("dim", item.description)}`;
      }
      lines.push(truncateToWidth(`${prefix}${text}`, width));
    }

    // Checkbox row: only when AI review is active.
    if (this.options.runReview) {
      lines.push("");
      const isSelected = this.selectedIndex === this.options.items.length;
      const prefix = isSelected ? t.fg("accent", "▸ ") : "  ";
      const box = this.autoAllow ? t.fg("accent", "[x]") : t.fg("dim", "[ ]");
      let text = `${box} ${t.fg("dim", AUTO_LABEL)}`;
      if (this.countdownActive) {
        text += t.fg("syntaxType", ` (${this.countdownRemaining}s)`);
      }
      lines.push(truncateToWidth(prefix + text, width));
    }

    return lines;
  }

  private renderBody(width: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - 3);
    const maxLines = this.options.maxBodyLines ?? DEFAULT_MAX_BODY_LINES;
    const rawLines = this.options.body!.split("\n");
    const rendered = rawLines
      .slice(0, maxLines)
      .flatMap((line) => wrapTextWithAnsi(line, contentWidth))
      .slice(0, maxLines)
      .map((line) => `  ${t.fg("muted", line)}`);
    if (rawLines.length > maxLines) rendered.push(`  ${t.fg("dim", "...")}`);
    return rendered.length ? rendered : [`  ${t.fg("dim", "(empty)")}`];
  }

  private renderAI(width: number): string {
    const t = this.theme;
    const prefix = "      ";
    let body: string;
    if (this.aiState.status === "pending") {
      body = t.fg("dim", "AI Reviewing...");
    } else if (this.aiState.status === "safe") {
      const reason = this.aiState.reason ? ` - ${this.aiState.reason}` : "";
      // syntaxType is the theme's clearest green; toolDiffAdded renders olive/yellowish.
      body = t.fg("syntaxType", `Safe${reason}`);
    } else if (this.aiState.status === "review") {
      const reason = this.aiState.reason ? ` - ${this.aiState.reason}` : "";
      body = t.fg("warning", `Review${reason}`);
    } else {
      body = t.fg("dim", this.aiState.reason);
    }
    return truncateToWidth(t.fg("dim", prefix) + body, width);
  }

  private startReview(): void {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.timeoutHandle = setTimeout(
      () => this.abortController?.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    this.options.runReview!(signal)
      .then((result) => {
        if (this.closed) return;
        if (signal.aborted) {
          this.aiState = { status: "failed", reason: "timed out" };
        } else {
          this.aiState = { status: result.decision, reason: result.reason };
        }
        this.tui.requestRender();
        this.maybeStartCountdown();
        // If not auto-approving (safe + checked + countdown-active), signal wait.
        const autoApproving = this.aiState.status === "safe" && this.autoAllow && this.countdownActive;
        if (!autoApproving) this.fireWaitApprove();
      })
      .catch(() => {
        if (this.closed) return;
        this.aiState = { status: "failed", reason: signal.aborted ? "timed out" : "unavailable" };
        this.tui.requestRender();
        // Auto-approve not possible on failure → safe to signal wait.
        this.fireWaitApprove();
      })
      .finally(() => {
        if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
        this.timeoutHandle = null;
      });
  }

  // Auto-allow countdown: only when the box is checked, AI said safe, Allow is
  // selected, and it hasn't already been cancelled for this command.
  private maybeStartCountdown(): void {
    if (this.countdownCancelled) return;
    if (!this.autoAllow) return;
    if (this.aiState.status !== "safe") return;
    if (this.countdownActive) return;
    // Don't auto-allow when cursor is on the Deny row (conflicting intent).
    if (this.options.items[this.selectedIndex]?.value === "deny") return;

    this.countdownActive = true;
    this.countdownRemaining = COUNTDOWN_SECONDS;
    this.tui.requestRender();
    this.countdownInterval = setInterval(() => {
      if (this.closed) return;
      this.countdownRemaining--;
      if (this.countdownRemaining <= 0) {
        this.finish({
          value: "allow",
          note: this.input.getValue().trim(),
          auto: true,
          autoReason: this.aiState.status === "safe" ? this.aiState.reason : "",
        });
      } else {
        this.tui.requestRender();
      }
    }, 1000);
  }

  private cancelCountdown(): void {
    if (!this.countdownActive) return;
    this.countdownActive = false;
    this.countdownCancelled = true;
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    this.tui.requestRender();
  }

  private fireWaitApprove(): void {
    if (this.hasFiredWait) return;
    if (!this.options.onWaitApprove) return;
    this.hasFiredWait = true;
    const review =
      this.aiState.status === "safe" || this.aiState.status === "review"
        ? { decision: this.aiState.status, reason: this.aiState.reason }
        : undefined;
    this.options.onWaitApprove(review);
  }

  private submit(): void {
    const item = this.options.items[this.selectedIndex];
    if (!item) return;
    this.finish({ value: item.value, note: this.input.getValue().trim() });
  }

  private finish(result: ApproveDialogResult): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    this.abortController?.abort();
    this.done(result);
  }
}

export async function approveDialog(
  pi: ExtensionAPI,
  ctx: any,
  options: ApproveDialogOptions,
): Promise<ApproveDialogResult> {
  return withModal(pi, () => ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (r: ApproveDialogResult) => void) =>
      new ApproveDialog(options, theme, tui, done),
  ));
}