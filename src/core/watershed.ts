import type { DirectionResult, ElevationGrid } from "./types.js";

export interface WatershedResult {
  /** Pour-point index+1 for each cell; 0 = drains to no designated pour point. */
  labels: Int32Array;
  /** Pour point cell ids in label order (label 1 -> index 0). */
  pourPointIds: number[];
  /** Cell count per label (index 0 = unassigned). */
  counts: number[];
  /** Actual area per label. */
  areas: number[];
}

/**
 * Delineate watersheds for designated pour points. Every active cell is
 * assigned to the pour point found on its own downstream path, so nested /
 * upstream pour points own exactly their contributing area and never steal
 * cells that actually pass a closer designated pour.
 */
export function delineateWatersheds(
  g: ElevationGrid,
  d: DirectionResult,
  pourPointIds: number[],
): WatershedResult {
  const n = g.elev.length;
  const labels = new Int32Array(n);
  const pourLabel = new Int32Array(n).fill(-1);
  [...pourPointIds]
    .sort((a, b) => a - b)
    .forEach((id, i) => {
      pourLabel[id] = i + 1;
    });

  const indeg = new Int32Array(n);
  for (let id = 0; id < n; id++) {
    const dn = d.downstream[id];
    if (dn !== undefined && dn >= 0) indeg[dn]++;
  }
  const topo: number[] = [];
  const queue: number[] = [];
  for (let id = 0; id < n; id++) {
    if (!Number.isNaN(g.elev[id] as number) && indeg[id] === 0) queue.push(id);
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++] as number;
    topo.push(cur);
    const dn = d.downstream[cur];
    if (dn !== undefined && dn >= 0) {
      indeg[dn]--;
      if (indeg[dn] === 0) queue.push(dn);
    }
  }
  // Sinks first: a cell inherits the label carried past its downstream edge,
  // unless the cell itself is a designated pour point.
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i] as number;
    if (pourLabel[id] >= 0) {
      labels[id] = pourLabel[id] as number;
      continue;
    }
    const dn = d.downstream[id];
    labels[id] = dn !== undefined && dn >= 0 ? (labels[dn] as number) : 0;
  }

  const counts = new Array<number>(pourPointIds.length + 1).fill(0);
  for (let id = 0; id < n; id++) {
    const lab = labels[id];
    if (lab !== undefined && lab > 0) counts[lab] = (counts[lab] as number) + 1;
  }
  const cellArea = g.cellSize * g.cellSize;
  const areas = counts.map((c) => c * cellArea);
  return { labels, pourPointIds: [...pourPointIds].sort((a, b) => a - b), counts, areas };
}
