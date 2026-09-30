import { neighbors } from "./grid.js";
import type { ElevationGrid } from "./types.js";

export interface PitInfo {
  id: number;
  row: number;
  col: number;
  elev: number;
  /** True when the pit can reach a boundary through valid cells (surface-connected). */
  reachesBoundary: boolean;
}

/**
 * Inspect raw terrain depressions: valid cells with no strictly lower valid
 * neighbour. NoData neighbours are ignored (barriers), never treated as low.
 */
export function findPits(g: ElevationGrid): PitInfo[] {
  const pits: PitInfo[] = [];
  for (let id = 0; id < g.elev.length; id++) {
    const z = g.elev[id] as number;
    if (Number.isNaN(z)) continue;
    let hasLower = false;
    for (const nb of neighbors(g, id)) {
      const nz = g.elev[nb.id];
      if (nz !== undefined && !Number.isNaN(nz) && nz < z - 1e-12) {
        hasLower = true;
        break;
      }
    }
    if (!hasLower) {
      const r = Math.floor(id / g.ncols);
      pits.push({ id, row: r, col: id - r * g.ncols, elev: z, reachesBoundary: false });
    }
  }
  return pits;
}

/** Basic statistics used by reports and CLI status output. */
export function gridStats(g: ElevationGrid): {
  validCells: number;
  nodataCells: number;
  min: number;
  max: number;
  totalArea: number;
} {
  let valid = 0;
  let nodata = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const z of g.elev) {
    if (Number.isNaN(z)) nodata++;
    else {
      valid++;
      if (z < min) min = z;
      if (z > max) max = z;
    }
  }
  return {
    validCells: valid,
    nodataCells: nodata,
    min,
    max,
    totalArea: valid * g.cellSize * g.cellSize,
  };
}
