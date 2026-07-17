/**
 * Mode indicators: the footer badge (via pi:footer-mode) and the status-line
 * label (via ctx.ui.setStatus). ask has no footer badge (footer-hub shows the
 * default); it still gets a status label.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Mode } from "../core/types.ts";
import type { RuntimeState } from "../core/state.ts";

export function emitFooterMode(pi: ExtensionAPI, state: RuntimeState): void {
  const labels: Record<Mode, string | null> = {
    ask: null, // footer-hub shows default
    plan: "\x1b[38;5;36m\u{F03E4} plan\x1b[0m", // pause, teal
    auto: "\x1b[33m\u{F040A} auto\x1b[0m", // play, yellow
  };
  pi.events.emit("pi:footer-mode", { label: labels[state.mode] });
}

export function updateStatus(state: RuntimeState): void {
  if (!state.currentCtx) return;
  const labels: Record<Mode, string> = {
    ask: "\x1b[90m\u{F04DB} ask\x1b[0m", // stop, gray
    plan: "\x1b[38;5;36m\u{F03E4} plan\x1b[0m", // pause, teal
    auto: "\x1b[33m\u{F040A} auto\x1b[0m", // play, yellow
  };
  state.currentCtx.ui.setStatus("agent-mode", labels[state.mode]);
}
