import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EV_MODAL } from "./events.ts";

export async function withModal<T>(
  pi: ExtensionAPI,
  show: () => Promise<T>,
): Promise<T> {
  pi.events.emit(EV_MODAL, { phase: "open" });
  try {
    return await show();
  } finally {
    pi.events.emit(EV_MODAL, { phase: "close" });
  }
}
