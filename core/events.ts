/**
 * Outbound event-bus names for pi-run-mode.
 *
 * No hard dependency on footer / notify / next-cue — consumers (or a thin
 * bridge extension) listen and map to their own contracts.
 */

/** Mode badge update. Payload: `{ label: string | null }`. */
export const EV_MODE = "pi-run-mode:mode";

/** Desktop / UI notify request. Payload mirrors common notify buses. */
export const EV_NOTIFY = "pi-run-mode:notify";

/**
 * Modal lifecycle (approval dialogs). Payload: `{ phase: "open" | "close" }`.
 * Useful for pausing ephemeral UI (e.g. next-cue) while a prompt is up.
 */
export const EV_MODAL = "pi-run-mode:modal";
