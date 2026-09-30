import { D8_NEIGHBORS, DIR_CODE, DIR_OUT, DIR_SINK } from "./types.ts";
import type { ElevationGrid } from "./types.ts";

export function idx(r: number, c: number, cols: number): number {
  return r * cols + c;
}

export function rc(index: number, cols: number): [number, number] {
  return [Math.floor(index / cols), index % cols];
}

export function inBounds(
  r: number,
  c: number,
  rows: number,
  cols: number,
): boolean {
  return r >= 0 && c >= 0 && r < rows && c < cols;
}

export function isBoundary(
  r: number,
  c: number,
  rows: number,
  cols: number,
): boolean {
  return r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
}

/**
 * Enumerate the 8 neighbours of a cell. When a neighbour lies outside the
 * grid the returned index is -1 and `outside` is true. NoData neighbours
 * have valid coordinates but the caller must consult the mask.
 */
export function neighbors(
  r: number,
  c: number,
  rows: number,
  cols: number,
): Array<{
  k: number;
  code: number;
  nr: number;
  nc: number;
  index: number;
  dist: number;
  outside: boolean;
}> {
  const out = [];
  for (let k = 0; k < 8; k++) {
    const [dr, dc, dist] = D8_NEIGHBORS[k];
    const nr = r + dr;
    const nc = c + dc;
    const outside = !inBounds(nr, nc, rows, cols);
    out.push({
      k,
      code: DIR_CODE[k],
      nr,
      nc,
      index: outside ? -1 : idx(nr, nc, cols),
      dist,
      outside,
    });
  }
  return out;
}

/**
 * Build a grid from a 2D JS matrix. `null` entries (or entries equal to
 * noDataValue) become NoData. Deterministic regardless of input ordering.
 */
export function gridFromMatrix(
  matrix: Array<Array<number | null>>,
  cellSize: number,
  noDataValue: number | null = null,
): ElevationGrid {
  const rows = matrix.length;
  if (rows === 0) throw new Error("grid has zero rows");
  const cols = matrix[0].length;
  if (cols === 0) throw new Error("grid has zero cols");
  const elev = new Float64Array(rows * cols);
  const mask = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const row = matrix[r];
    if (row.length !== cols)
      throw new Error(`row ${r} has ${row.length} cells, expected ${cols}`);
    for (let c = 0; c < cols; c++) {
      const v = row[c];
      const i = idx(r, c, cols);
      const missing =
        v === null ||
        Number.isNaN(v) ||
        (noDataValue !== null && v === noDataValue);
      if (missing) {
        mask[i] = 1;
        elev[i] = NaN;
      } else {
        elev[i] = v;
      }
    }
  }
  return { rows, cols, cellSize, elev, mask, noDataValue };
}

export function validCellCount(grid: {
  rows: number;
  cols: number;
  mask: Uint8Array;
}): number {
  let n = 0;
  for (let i = 0; i < grid.mask.length; i++) if (!grid.mask[i]) n++;
  return n;
}

export { DIR_OUT, DIR_SINK };
