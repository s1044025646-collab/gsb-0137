import { MinHeap } from "./binheap.js";
import { neighbors, rc } from "./grid.js";
import type { ElevationGrid, FillStrategy } from "./types.js";

export interface FillResult {
  /** Surface used for routing; raw when NONE, depression-filled when FILL. */
  surface: Float64Array;
  /** surface - raw, >= 0 for every valid cell. */
  raiseAmount: Float64Array;
  /** Neighbour cell that supplied the spill water level when raised; else null. */
  raiseEvidence: Int32Array;
  /** Valid cells belonging to a region with no outlet (boundary / pour point). */
  closed: Uint8Array;
}

/**
 * Mark valid cells unreachable (4/8-connected through valid cells) from any
 * outlet. Outlets are valid boundary cells plus the explicitly designated
 * pour points. NoData cells are barriers and are never traversed.
 */
export function findClosedRegions(g: ElevationGrid, pourPointIds: number[]): Uint8Array {
  const n = g.elev.length;
  const closed = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const queue: number[] = [];
  const seed = (id: number): void => {
    if (!visited[id] && !Number.isNaN(g.elev[id] as number)) {
      visited[id] = 1;
      queue.push(id);
    }
  };
  for (let id = 0; id < n; id++) {
    if (Number.isNaN(g.elev[id] as number)) continue;
    const [r, c] = rc(id, g.ncols);
    if (r === 0 || c === 0 || r === g.nrows - 1 || c === g.ncols - 1) seed(id);
  }
  for (const id of pourPointIds) seed(id);

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++] as number;
    for (const nb of neighbors(g, cur)) {
      if (visited[nb.id] || Number.isNaN(g.elev[nb.id] as number)) continue;
      visited[nb.id] = 1;
      queue.push(nb.id);
    }
  }
  for (let id = 0; id < n; id++) {
    if (!Number.isNaN(g.elev[id] as number) && !visited[id]) closed[id] = 1;
  }
  return closed;
}

/**
 * Depression filling via a deterministic Priority-Flood (Wang & Liu style).
 *
 * The flood front starts at every outlet (boundary valid cells + pour points).
 * A cell reached with water level W is set to max(rawElev, W); when rawElev < W
 * the cell is raised to W and the cell that carried W is recorded as drainage
 * evidence. NoData is an absolute barrier and its (NaN) value is never read as
 * a low elevation. Cells never reached are closed depressions with no external
 * spill path and are reported, not filled by random perturbation.
 */
export function fillSinks(
  g: ElevationGrid,
  strategy: FillStrategy,
  pourPointIds: number[],
): FillResult {
  const n = g.elev.length;
  const surface = Float64Array.from(g.elev);
  const raiseAmount = new Float64Array(n);
  const raiseEvidence = new Int32Array(n).fill(-1);
  const closed = findClosedRegions(g, pourPointIds);

  if (strategy === "NONE") {
    return { surface, raiseAmount, raiseEvidence, closed };
  }

  const done = new Uint8Array(n);
  const heap = new MinHeap();
  const waterLevel = new Float64Array(n);

  const pushOutlet = (id: number): void => {
    if (done[id] || Number.isNaN(g.elev[id] as number)) return;
    done[id] = 1;
    waterLevel[id] = g.elev[id] as number;
    heap.push(id, g.elev[id] as number);
  };
  for (let id = 0; id < n; id++) {
    if (closed[id]) continue;
    const [r, c] = rc(id, g.ncols);
    if (r === 0 || c === 0 || r === g.nrows - 1 || c === g.ncols - 1) pushOutlet(id);
  }
  for (const id of pourPointIds) pushOutlet(id);

  let entry = heap.pop();
  while (entry !== undefined) {
    const cur = entry.id;
    const level = entry.key;
    for (const nb of neighbors(g, cur)) {
      const nid = nb.id;
      if (done[nid] || Number.isNaN(g.elev[nid] as number) || closed[nid]) continue;
      done[nid] = 1;
      const raw = g.elev[nid] as number;
      if (raw >= level) {
        waterLevel[nid] = raw;
        surface[nid] = raw;
      } else {
        waterLevel[nid] = level;
        surface[nid] = level;
        raiseAmount[nid] = level - raw;
        raiseEvidence[nid] = cur;
      }
      heap.push(nid, waterLevel[nid] as number);
    }
    entry = heap.pop();
  }

  for (let id = 0; id < n; id++) {
    if (closed[id]) surface[id] = g.elev[id] as number;
  }
  return { surface, raiseAmount, raiseEvidence, closed };
}
