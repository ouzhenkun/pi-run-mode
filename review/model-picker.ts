/**
 * ModelPicker — searchable model selector with fuzzy matching.
 *
 * Fuzzy logic: input is split by spaces into tokens; an item matches if its
 * label contains ALL tokens (case-insensitive, order-independent).
 * e.g. "xh op" matches "xcc-xh/claude-opus-4-6"
 *
 * Layout:
 *   ──────────────────────────────
 *    Choose model:
 *    🔍 _
 *    ▸ provider/model-id
 *      provider/model-id
 *      ...
 *    ↑↓ navigate  type to filter  ↵ select  esc cancel
 *   ──────────────────────────────
 */

import {
  Input,
  SelectList,
  type SelectItem,
  type SelectListTheme,
  matchesKey,
  Key,
} from "@earendil-works/pi-tui";

export type PickedModel = { provider: string; id: string } | null;

const SEARCH_LABEL = " ";

function fuzzyMatch(label: string, query: string): boolean {
  if (!query) return true;
  const lower = label.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((t) => subsequence(lower, t));
}

/** Check if all chars in needle appear in haystack in order (subsequence match). */
function subsequence(haystack: string, needle: string): boolean {
  let hi = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const idx = haystack.indexOf(needle[ni], hi);
    if (idx === -1) return false;
    hi = idx + 1;
  }
  return true;
}

class ModelPickerDialog {
  private selectList: SelectList;
  private readonly input: Input;
  private readonly theme: any;
  private readonly tui: any;
  private readonly done: (result: PickedModel) => void;
  private readonly allItems: SelectItem[];
  private readonly listTheme: SelectListTheme;
  private _focused = false;

  constructor(
    items: SelectItem[],
    theme: any,
    tui: any,
    done: (result: PickedModel) => void,
  ) {
    this.allItems = items;
    this.theme = theme;
    this.tui = tui;
    this.done = done;

    this.listTheme = {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    };

    this.selectList = this.buildList(items);

    this.input = new Input();
    this.input.onEscape = () => done(null);
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, Math.min(items.length, 12), this.listTheme);
    list.onSelect = (item) => {
      const slashIdx = item.value.indexOf("/");
      if (slashIdx !== -1) {
        this.done({ provider: item.value.slice(0, slashIdx), id: item.value.slice(slashIdx + 1) });
      } else {
        this.done(null);
      }
    };
    list.onCancel = () => this.done(null);
    return list;
  }

  // --- Focusable ---

  get focused(): boolean {
    return this._focused;
  }

  set focused(v: boolean) {
    this._focused = v;
    this.input.focused = v;
  }

  // --- Component ---

  invalidate(): void {
    this.selectList.invalidate();
    this.input.invalidate();
  }

  handleInput(data: string): void {
    // Up/Down: always go to list navigation
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.selectList.handleInput(data);
      this.tui.requestRender();
      return;
    }

    // Enter: select current item
    if (matchesKey(data, Key.enter)) {
      const item = this.selectList.getSelectedItem();
      if (item) {
        this.selectList.onSelect?.(item);
      }
      return;
    }

    // Esc: cancel
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }

    // All other input goes to the search Input, then rebuild list with fuzzy filter
    this.input.handleInput(data);
    const query = this.input.getValue();
    const filtered = this.allItems.filter((item) => fuzzyMatch(item.label, query));
    this.selectList = this.buildList(filtered.length > 0 ? filtered : [{ value: "", label: "No match", description: "" }]);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];

    // Top border
    lines.push(t.fg("accent", "─".repeat(width)));

    // Title
    lines.push(` ${t.fg("accent", t.bold("Choose model:"))}`);

    // Search row
    const inputWidth = Math.max(1, width - SEARCH_LABEL.length);
    const inputLines = this.input.render(inputWidth);
    lines.push(t.fg("accent", SEARCH_LABEL) + (inputLines[0] ?? ""));

    // Blank line between search and list
    lines.push("");

    // SelectList items
    lines.push(...this.selectList.render(width));

    // Help hint
    lines.push(` ${t.fg("dim", "↑↓ navigate  type to filter  ↵ select  esc cancel")}`);

    // Bottom border
    lines.push(t.fg("accent", "─".repeat(width)));

    return lines;
  }
}

/**
 * Show a searchable model picker dialog with fuzzy matching.
 *
 * Returns `{ provider, id }` on confirm, or `null` if cancelled.
 */
export async function pickModel(
  ctx: any,
  models: Array<{ provider: string; id: string }>,
): Promise<PickedModel> {
  const items: SelectItem[] = models.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.provider}/${m.id}`,
  }));

  return ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (r: PickedModel) => void) =>
      new ModelPickerDialog(items, theme, tui, done),
  );
}
