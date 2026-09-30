import { MinHeap } from "./binheap.js";
import { D8_DIST, neighbors, rc, steepestDownslope } from "./grid.js";
import { fillSinks } from "./sinkfill.js";
import type {
  CellSourceInfo,
  CellStatus,
  DirectionResult,
  ElevationGrid,
  FillStrategy,
} from "./types.js";

/**
 * Compute D8 flow directions.
 *
 *  1. Sloped cells route to the neighbour with maximum real gradient
 *     (drop / true centre distance: 1 cardinal, sqrt(2) diagonal). Ties are
 *     broken by the lowest direction code for determinism.
 *  2. Flat cells are resolved with the Barnes et al. (2014) two-gradient method:
 *       - a towards-lower gradient spreads from cells that have a lower
         neighbour, guaranteeing flow toward an outlet;
       - an away-from-high gradient spreads from high cells, giving unique
         spill paths across flats;
       - the combined strictly-decreasing scalar guarantees no cycles.
 *  3. Closed regions (no outlet) and NONE-strategy pits get no direction and
 *     are reported. NoData is never treated as a low elevation.
 */
export function computeFlowDirections(
  g: ElevationGrid,
  strategy: FillStrategy,
  pourPointIds: number[],
): DirectionResult {
  const n = g.elev.length;
  const { surface, raiseAmount, raiseEvidence, closed } = fillSinks(g, strategy, pourPointIds);

  const dir = new Uint8Array(n);
  const downstream = new Int32Array(n).fill(-1);
  const source: CellSourceInfo[] = new Array(n);
  const closedCellIds: number[] = [];
  const pitCellIds: number[] = [];
  const raisedCellIds: number[] = [];

  for (let id = 0; id < n; id++) {
    const raw = g.elev[id] as number;
    if (Number.isNaN(raw)) continue;
    if (closed[id]) {
      source[id] = {
        processedElev: raw,
        rawElev: raw,
        raiseAmount: 0,
        status: "CLOSED",
        drainsToEvidence: null,
      };
      closedCellIds.push(id);
    }
  }

  // EPS-classification of non-closed cells.
  const LOW = 1;
  const HIGH = 2;
  const epsClass = new Uint8Array(n);
  const active = new Uint8Array(n);
  for (let id = 0; id < n; id++) {
    if (Number.isNaN(g.elev[id] as number) || closed[id]) continue;
    active[id] = 1;
    let hasLower = false;
    let hasHigher = false;
    for (const nb of neighbors(g, id)) {
      const z = surface[nb.id];
      if (z === undefined || Number.isNaN(z) || closed[nb.id]) continue;
      if (z < (surface[id] as number) - 1e-12) hasLower = true;
      else if (z > (surface[id] as number) + 1e-12) hasHigher = true;
    }
    if (hasLower) epsClass[id] = LOW;
    else if (hasHigher) epsClass[id] = HIGH;
  }

  // awayFromHigh: multi-source Dijkstra in true planar distance.
  const away = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const awayHeap = new MinHeap();
  for (let id = 0; id < n; id++) {
    if (epsClass[id] === HIGH) {
      away[id] = 0;
      awayHeap.push(id, 0);
    }
  }
  let e = awayHeap.pop();
  while (e !== undefined) {
    if (e.key > (away[e.id] as number) + 1e-12) {
      e = awayHeap.pop();
      continue;
    }
    for (const nb of neighbors(g, e.id)) {
      if (!active[nb.id]) continue;
      const d = e.key + (D8_DIST[nb.code] as number);
      if (d + 1e-12 < (away[nb.id] as number)) {
        away[nb.id] = d;
        awayHeap.push(nb.id, d);
      }
    }
    e = awayHeap.pop();
  }

  // towardsLower via BFS (hops); lower cells start at 0.
  const towards = new Int32Array(n).fill(-1);
  const q: number[] = [];
  for (let id = 0; id < n; id++) {
    if (epsClass[id] === LOW) {
      towards[id] = 0;
      q.push(id);
    }
  }
  let head = 0;
  while (head < q.length) {
    const cur = q[head++] as number;
    for (const nb of neighbors(g, cur)) {
      if (!active[nb.id] || towards[nb.id] !== -1) continue;
      if (epsClass[nb.id] === LOW) continue;
      towards[nb.id] = (towards[cur] as number) + 1;
      q.push(nb.id);
    }
  }

  for (let id = 0; id < n; id++) {
    if (!active[id]) continue;
    const raw = g.elev[id] as number;
    const proc = surface[id] as number;
    const raised = raiseAmount[id] > 1e-9;
    if (raised) raisedCellIds.push(id);

    const steep = steepestDownslope(g, surface, id);
    if (steep !== null) {
      dir[id] = steep.code;
      downstream[id] = steep.id;
      source[id] = makeSource(raw, proc, raised, raiseEvidence[id], "UNCHANGED");
      continue;
    }

    // Flat cell: choose neighbour with (towards--, away--); deterministic code tie-break.
    if (towards[id] > 0) {
      let pick: { id: number; code: number; away: number } | null = null;
      for (const nb of neighbors(g, id)) {
        if (!active[nb.id]) continue;
        if ((towards[nb.id] as number) !== (towards[id] as number) - 1) continue;
        const av = Number.isFinite(away[nb.id] as number) ? (away[nb.id] as number) : 1e30;
        if (
          pick === null ||
          av < pick.away - 1e-12 ||
          (Math.abs(av - pick.away) <= 1e-12 && nb.code < pick.code)
        ) {
          pick = { id: nb.id, code: nb.code, away: av };
        }
      }
      if (pick !== null) {
        dir[id] = pick.code;
        downstream[id] = pick.id;
        const status: CellStatus = raised ? "RAISED" : "FLAT_ROUTED";
        source[id] = makeSource(raw, proc, raised, raised ? raiseEvidence[id] : pick.id, status);
        continue;
      }
    }

    // No outlet on the surface.
    if (strategy === "NONE") {
      pitCellIds.push(id);
      source[id] = {
        processedElev: proc,
        rawElev: raw,
        raiseAmount: 0,
        status: "PIT",
        drainsToEvidence: null,
      };
    } else {
      source[id] = {
        processedElev: proc,
        rawElev: raw,
        raiseAmount: raiseAmount[id],
        status: "RAISED",
        drainsToEvidence: raiseEvidence[id] >= 0 ? raiseEvidence[id] : null,
      };
    }
  }

  return { dir, downstream, source, closedCellIds, pitCellIds, raisedCellIds };
}

function makeSource(
  raw: number,
  proc: number,
  raised: boolean,
  evidence: number,
  fallback: CellStatus,
): CellSourceInfo {
  return {
    processedElev: proc,
    rawElev: raw,
    raiseAmount: Math.max(0, proc - raw),
    status: raised ? "RAISED" : fallback,
    drainsToEvidence: raised ? (evidence >= 0 ? evidence : null) : null,
  };
}

/** Validate that the direction graph contains no directed cycle among active cells. */
export function assertAcyclic(d: DirectionResult): void {
  const n = d.downstream.length;
  const state = new Uint8Array(n); // 0 unseen, 1 in stack, 2 done
  for (let start = 0; start < n; start++) {
    if (state[start] || d.downstream[start] === -1) continue;
    let cur = start;
    const path: number[] = [];
    while (cur !== -1 && state[cur] === 0) {
      state[cur] = 1;
      path.push(cur);
      cur = d.downstream[cur] as number;
    }
    if (cur !== -1 && state[cur] === 1) {
      throw new Error(`flow direction cycle detected involving cell ${cur}`);
    }
    for (const id of path) state[id] = 2;
  }
}

export function traceDownstreamPath(d: DirectionResult, startId: number): number[] {
  const path: number[] = [];
  const seen = new Set<number>();
  let cur = startId;
  while (cur !== -1) {
    if (seen.has(cur)) throw new Error(`cycle while tracing path from ${startId}`);
    seen.add(cur);
    path.push(cur);
    cur = d.downstream[cur] as number;
  }
  return path;
}

export function cellRC(id: number, ncols: number): [number, number] {
  return rc(id, ncols);
}
