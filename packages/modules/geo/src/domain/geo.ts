// geo domain rules (Phase 1 01 §4.2 geo, 04 §5, ADR-025 #9): search-text normalisation, the India bounding box for
// points, and the shortest travel path over the locality adjacency graph.

/** NFC, lower case, every run of non-letter / non-digit characters (keeping combining marks, e.g. Telugu vowel signs) → one space. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

/** 04 §5: points must lie inside India's bounding box. */
export function isInIndia(point: { readonly lat: number; readonly lng: number }): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lng) && point.lat >= 6 && point.lat <= 37.5 && point.lng >= 68 && point.lng <= 97.5;
}

export interface AdjacencyEdge {
  readonly from: string;
  readonly to: string;
  readonly minutes: number;
}

/** Dijkstra over typical travel minutes. Null when `to` can't be reached. */
export function shortestTravel(edges: readonly AdjacencyEdge[], from: string, to: string): { readonly minutes: number; readonly hops: number } | null {
  if (from === to) return { minutes: 0, hops: 0 };
  const out = new Map<string, AdjacencyEdge[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const best = new Map<string, { minutes: number; hops: number }>([[from, { minutes: 0, hops: 0 }]]);
  const done = new Set<string>();
  for (;;) {
    let current: string | undefined;
    for (const [node, d] of best) {
      if (!done.has(node) && (current === undefined || d.minutes < (best.get(current)?.minutes ?? Infinity))) current = node;
    }
    if (current === undefined) return null;
    const here = best.get(current) ?? { minutes: 0, hops: 0 };
    if (current === to) return here;
    done.add(current);
    for (const e of out.get(current) ?? []) {
      const next = { minutes: here.minutes + e.minutes, hops: here.hops + 1 };
      const known = best.get(e.to);
      if (!done.has(e.to) && (!known || next.minutes < known.minutes)) best.set(e.to, next);
    }
  }
}
