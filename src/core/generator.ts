import { buildGrid } from "./grid.js";
import type { ElevationGrid } from "./types.js";

export type DemPattern =
  | "slope"
  | "double-valley"
  | "closed-depression"
  | "flat"
  | "nodata-hole";

export interface GenOptions {
  pattern: DemPattern;
  nrows?: number;
  ncols?: number;
  cellSize?: number;
  /** Injected RNG (defaults to a seeded deterministic PRNG) for reproducibility. */
  random?: () => number;
  seed?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic synthetic elevation matrices. NoData holes carve NaN cells.
 * Values are plain numbers so the output round-trips through buildGrid().
 */
export function generateDem(opts: GenOptions): ElevationGrid {
  const nrows = opts.nrows ?? 10;
  const ncols = opts.ncols ?? 12;
  const cellSize = opts.cellSize ?? 10;
  const rnd = opts.random ?? mulberry32(opts.seed ?? 12345);
  const rows: (number | null)[][] = Array.from({ length: nrows }, () =>
    new Array<number | null>(ncols).fill(0),
  );
  const set = (r: number, c: number, v: number): void => {
    if (r >= 0 && r < nrows && c >= 0 && c < ncols) rows[r]![c] = v;
  };

  switch (opts.pattern) {
    case "slope":
      for (let r = 0; r < nrows; r++)
        for (let c = 0; c < ncols; c++) set(r, c, (nrows - r) * 5 + (ncols - c) * 2);
      break;
    case "double-valley":
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          const v1 = Math.abs(c - ncols * 0.25) * 4;
          const v2 = Math.abs(c - ncols * 0.75) * 4;
          set(r, c, (nrows - r) * 1.5 + Math.min(v1, v2) + 20);
        }
      }
      break;
 case "closed-depression":
      for (let r = 0; r < nrows; r++)
        for (let c = 0; c < ncols; c++) {
          const dr = r - (nrows - 1) / 2;
          const dc = c - (ncols - 1) / 2;
          const d = Math.sqrt(dr * dr + dc * dc);
          // Bowl surrounded by a raised rim so the interior cannot spill out.
          const rim = Math.max(0, 1 - Math.abs(d - Math.min(nrows, ncols) / 3));
          set(r, c, 100 - d * 3 + rim * 25);
        }
      break;
    case "flat":
      for (let r = 0; r < nrows; r++)
        for (let c = 0; c < ncols; c++) {
          // Large interior plateau at 50 with a single gentle drop near the edge.
          set(r, c, r === nrows - 1 ? 10 : 50);
        }
      break;
    case "nodata-hole":
      for (let r = 0; r < nrows; r++)
        for (let c = 0; c < ncols; c++) set(r, c, (nrows - r) * 5 + (ncols - c) * 2);
      for (let r = Math.floor(nrows / 2) - 1; r <= Math.floor(nrows / 2) + 1; r++)
        for (let c = Math.floor(ncols / 2) - 1; c <= Math.floor(ncols / 2) + 1; c++)
          set(r, c, null as unknown as number);
      break;
  }

  // Tiny deterministic jitter (< 0.01) never crosses an integer contour but
  // keeps byte-level output stable for the same seed.
  for (let r = 0; r < nrows; r++)
    for (let c = 0; c < ncols; c++) {
      const v = rows[r]![c];
      if (v !== null) rows[r]![c] = Math.round((v + (rnd() - 0.5) * 0.002) * 1e6) / 1e6;
    }

  return buildGrid(nrows, ncols, cellSize, rows);
}

export function gridToRows(g: ElevationGrid): (number | null)[][] {
  const rows: (number | null)[][] = [];
  for (let r = 0; r < g.nrows; r++) {
    const row: (number | null)[] = [];
    for (let c = 0; c < g.ncols; c++) {
      const v = g.elev[r * g.ncols + c] as number;
      row.push(Number.isNaN(v) ? null : v);
    }
    rows.push(row);
  }
  return rows;
}
