import type { DirCode, ElevationGrid } from "./types.js";

/** D8 neighbor offsets in direction-code order (1..8): E, SE, S, SW, W, NW, N, NE. */
export const D8_DR: readonly number[] = [0, 1, 1, 1, 0, -1, -1, -1];
export const D8_DC: readonly number[] = [1, 1, 0, -1, -1, -1, 0, 1];

/** Real centre-to-centre neighbour distance multiplier (cardinal 1, diagonal sqrt(2)). */
export const D8_DIST: readonly number[] = [
  Math.SQRT2, // code 1 placeholder index 0 (unused; codes start at 1)
  1, // 1 E
  Math.SQRT2, // 2 SE
  1, // 3 S
  Math.SQRT2, // 4 SW
  1, // 5 W
  Math.SQRT2, // 6 NW
  1, // 7 N
  Math.SQRT2, // 8 NE
];

export const rc = (id: number, ncols: number): [number, number] => [
  Math.floor(id / ncols),
  id % ncols,
];
export const idx = (r: number, c: number, ncols: number): number => r * ncols + c;
export const inBounds = (r: number, c: number, g: ElevationGrid): boolean =>
  r >= 0 && r < g.nrows && c >= 0 && c < g.ncols;
export const isValid = (g: ElevationGrid, id: number): boolean =>
  id >= 0 && id < g.elev.length && !Number.isNaN(g.elev[id] as number);

export interface Neighbor {
  id: number;
  code: DirCode;
  r: number;
  c: number;
  distance: number;
}

/** Enumerate the 8 valid (in-grid) neighbours of a cell. NoData is handled by the caller. */
export function neighbors(g: ElevationGrid, id: number): Neighbor[] {
  const [r, c] = rc(id, g.ncols);
  const out: Neighbor[] = [];
  for (let code = 1 as DirCode; code <= 8; code = (code + 1) as DirCode) {
    const nr = r + (D8_DR[code] as number);
    const nc = c + (D8_DC[code] as number);
    if (!inBounds(nr, nc, g)) continue;
    out.push({ id: idx(nr, nc, g.ncols), code, r: nr, c: nc, distance: D8_DIST[code] as number });
  }
  return out;
}

/** Steepest real-gradient (elevation drop / true neighbour distance) D8 neighbour. */
export function steepestDownslope(
  g: ElevationGrid,
  surf: Float64Array,
  id: number,
): { id: number; code: DirCode; gradient: number } | null {
  const here = surf[id] as number;
  let best: { id: number; code: DirCode; gradient: number } | null = null;
  for (const n of neighbors(g, id)) {
    const ne = surf[n.id];
    if (ne === undefined || Number.isNaN(ne)) continue;
    const gradient = (here - ne) / n.distance;
    if (gradient <= 0) continue;
    if (
      best === null ||
      gradient > best.gradient + 1e-12 ||
      (Math.abs(gradient - best.gradient) <= 1e-12 && n.code < best.code)
    ) {
      best = { id: n.id, code: n.code, gradient };
    }
  }
  return best;
}

/**
 * Validate an elevation payload. Throws an Error carrying `.code` used by the API/CLI.
 * NoData may be represented as NaN, null, or the string "NODATA".
 */
export function buildGrid(
  nrows: unknown,
  ncols: unknown,
  cellSize: unknown,
  rows: unknown,
): ElevationGrid {
  const nr = Number(nrows);
  const nc = Number(ncols);
  const cs = Number(cellSize);
  if (!Number.isInteger(nr) || nr <= 0) throw validationError("nrows must be a positive integer");
  if (!Number.isInteger(nc) || nc <= 0) throw validationError("ncols must be a positive integer");
  if (!Number.isFinite(cs) || cs <= 0) throw validationError("cellSize must be a positive number");
  if (!Array.isArray(rows)) throw validationError("rows must be an array of arrays");
  if (rows.length !== nr) throw validationError(`rows length ${rows.length} != nrows ${nr}`);
  const elev = new Float64Array(nr * nc);
  for (let r = 0; r < nr; r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.length !== nc) {
      throw validationError(`row ${r} must be an array of length ${nc}`);
    }
    for (let c = 0; c < nc; c++) {
      const v = row[c];
      if (v === null || v === "NODATA" || v === undefined) {
        elev[r * nc + c] = Number.NaN;
      } else {
        const num = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(num)) {
          throw validationError(`cell (${r},${c}) must be finite or null/"NODATA"`);
        }
        elev[r * nc + c] = num;
      }
    }
  }
  if (elev.every((z) => Number.isNaN(z))) {
    throw validationError("grid contains no valid (non-NoData) cells");
  }
  return { nrows: nr, ncols: nc, cellSize: cs, elev };
}

export function validationError(message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = "VALIDATION_ERROR";
  return e;
}

export function isBoundaryCell(g: ElevationGrid, id: number): boolean {
  const [r, c] = rc(id, g.ncols);
  return r === 0 || c === 0 || r === g.nrows - 1 || c === g.ncols - 1;
}
