import { assertAcyclic } from "./flowdir.js";
import type { AccumulationResult, DirectionResult, ElevationGrid } from "./types.js";

/**
 * Upstream contributing count and true area.
 * Count conservation: sum over the boundary-outlet set counts every routed
 * active cell exactly once (closed/pit-terminated cells are reported separately).
 */
export function computeAccumulation(g: ElevationGrid, d: DirectionResult): AccumulationResult {
  assertAcyclic(d);
  const n = g.elev.length;
  const count = new Float64Array(n);
  for (let id = 0; id < n; id++) {
    if (Number.isNaN(g.elev[id] as number)) continue;
    count[id] = 1;
  }
  const indeg = new Int32Array(n);
  for (let id = 0; id < n; id++) {
    const dn = d.downstream[id];
    if (dn !== undefined && dn >= 0) indeg[dn]++;
  }
  const queue: number[] = [];
  for (let id = 0; id < n; id++) {
    if (!Number.isNaN(g.elev[id] as number) && indeg[id] === 0) queue.push(id);
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++] as number;
    const dn = d.downstream[cur];
    if (dn !== undefined && dn >= 0) {
      count[dn] += count[cur] as number;
      if ((indeg[dn] as number) - 1 === 0) queue.push(dn);
      indeg[dn]--;
    }
  }
  const area = new Float64Array(n);
  const cellArea = g.cellSize * g.cellSize;
  for (let id = 0; id < n; id++) area[id] = (count[id] as number) * cellArea;
  return { count, area };
}

/** Extract stream cells by contributing-count threshold. */
export function extractStream(acc: AccumulationResult, thresholdCount: number): Uint8Array {
  const stream = new Uint8Array(acc.count.length);
  for (let id = 0; id < acc.count.length; id++) {
    if ((acc.count[id] as number) >= thresholdCount) stream[id] = 1;
  }
  return stream;
}
