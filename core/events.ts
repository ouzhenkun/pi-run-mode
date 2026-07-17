/**
 * Outbound event-bus names for pi-run-mode.
 *
 * No hard dependency on footer / desktop notifications / next-cue — consumers
 * listen and map these semantic events to their own contracts.
 */

/** Mode badge update. Payload: `{ label: string | null }`. */
export const EV_MODE = "pi-run-mode:change";

/** Notification request. Payload: `{ type: "approval-needed" | "plan-ready", body: string }`. */
export const EV_NOTIFY = "pi-run-mode:notify";

/**
 * Modal lifecycle (approval dialogs). Payload: `{ phase: "open" | "close" }`.
 * Useful for pausing ephemeral UI (e.g. next-cue) while a prompt is up.
 */
export const EV_MODAL = "pi-run-mode:modal";
