/**
 * CTB composition matching: exact match (case-insensitive, whitespace- and
 * extension-stripped) of each model name on the plate against a ScaleX
 * warehouse component. Ported 1:1 from own_manager.py's
 * `_normalize_composition_key()` / `match_composition_components()` — see
 * that file's own module-level comment (search "CTB composition") for the
 * full rationale, in particular why this is exact matching rather than the
 * substring/fuzzy match ScaleX's own browser code uses (that only ever
 * surfaces one guess, useless for a multi-model plate).
 *
 * Client-safe: pure functions, no `fetch`/Node deps, so this can run in the
 * webview before a job is sent (see the composition review panel wired up
 * from `src/app/page.tsx`).
 */

import type { ScaleXWarehouseComponent } from './scalexClient';

export type CompositionMatchedEntry = {
  component: ScaleXWarehouseComponent;
  quantity: number;
};

export type CompositionAmbiguousEntry = {
  modelName: string;
  candidates: ScaleXWarehouseComponent[];
  quantity: number;
};

export type CompositionMatchResult = {
  matched: CompositionMatchedEntry[];
  ambiguous: CompositionAmbiguousEntry[];
  unmatched: string[];
};

/**
 * Whitespace-anywhere-stripped, lowercased key. Real model names have come
 * back with stray spaces a warehouse code doesn't have (confirmed live:
 * "WW-35033 _W_R_A.stl" vs warehouse code "WW-35033_W_R_A"), so this strips
 * ALL whitespace, not just leading/trailing — a plain `.trim()` missed that
 * case entirely.
 */
export function normalizeCompositionKey(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

/**
 * Matches against BOTH a component's `code` and `name` fields — live data
 * confirmed real STL file names correspond to `name` ("WW-35033 _W_R_A"),
 * not the shorter, colon-separated `code` ("WW-35033W:RA") real files are
 * never actually named after. Checking both keeps this working for any
 * other product family that *does* happen to use code-style file names.
 *
 * Returns:
 * - `matched` — one entry per distinct, UNAMBIGUOUSLY matched component;
 *   `quantity` is how many times it appeared in `modelNames` (a plate
 *   commonly prints several copies of the same part).
 * - `ambiguous` — one entry per model name whose normalized key matches
 *   MORE THAN ONE component (the warehouse has several components under
 *   different articles/codes sharing the exact same name). There is no
 *   correct automatic choice here — which article is "the" target for that
 *   name is a warehouse-stock decision, not something derivable from the
 *   plate data — so these are surfaced for the operator to resolve instead
 *   of silently picking whichever component happened to come first.
 * - `unmatched` — model names with no match at all.
 */
export function matchCompositionComponents(
  modelNames: string[],
  components: ScaleXWarehouseComponent[],
): CompositionMatchResult {
  const byKey = new Map<string, ScaleXWarehouseComponent[]>();
  for (const c of components) {
    for (const keyField of ['code', 'name'] as const) {
      const raw = (c[keyField] as string | undefined) ?? '';
      const key = normalizeCompositionKey(String(raw));
      if (!key) continue;
      const group = byKey.get(key) ?? [];
      if (!group.some((existing) => String(existing.id) === String(c.id))) {
        group.push(c);
      }
      byKey.set(key, group);
    }
  }

  const counts = new Map<string, number>();
  const ambiguousGroups = new Map<string, CompositionAmbiguousEntry>();
  const unmatched: string[] = [];

  for (const name of modelNames) {
    const stem = normalizeCompositionKey(stripExtension(name));
    const candidates = byKey.get(stem);
    if (!candidates || candidates.length === 0) {
      unmatched.push(name);
    } else if (candidates.length === 1) {
      const id = String(candidates[0].id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    } else {
      const existing = ambiguousGroups.get(stem);
      if (existing) {
        existing.quantity += 1;
      } else {
        ambiguousGroups.set(stem, { modelName: name, candidates, quantity: 1 });
      }
    }
  }

  const compById = new Map(components.map((c) => [String(c.id), c] as const));
  const matched: CompositionMatchedEntry[] = [];
  for (const [id, quantity] of counts) {
    const component = compById.get(id);
    if (component) matched.push({ component, quantity });
  }

  return { matched, ambiguous: Array.from(ambiguousGroups.values()), unmatched };
}

/** '{name} (арт. {code})' — mirrors own_manager.py's _composition_item_label(): shows the matched article alongside the name, avoiding a redundant "X (арт. X)" when name and code are identical. */
export function compositionItemLabel(component: ScaleXWarehouseComponent): string {
  const name = String(component.name ?? component.code ?? component.id ?? '').trim();
  const code = String(component.code ?? '').trim();
  if (!code || code === name) return name || String(component.id);
  return `${name} (арт. ${code})`;
}
