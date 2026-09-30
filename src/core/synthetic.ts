import { gridFromMatrix } from "./grid.ts";
import type { ElevationGrid } from "./types.ts";

/** Deterministic 32-bit PRNG (mulberry32) so demos/tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticOptions {
  rows: number;
  cols: number;
  cellSize?: number;
  seed?: number;
  /** Add a closed depression (pit) when true. */
  pit?: boolean;
  /** Punch a rectangular NoData hole when true. */
  noDataHole?: boolean;
  /** Add a broad flat plateau when true. */
  flat?: boolean;
}

/**
 * Generate a synthetic tilted terrain with two valleys draining toward the
 * bottom edge. Features are optional so the same generator yields most test
 * fixtures. Fully deterministic for a given seed and options.
 */
export function generateSynthetic(opts: SyntheticOptions): ElevationGrid {
  const { rows, cols, cellSize = 10, seed = 1 } = opts;
  const rand = mulberry32(seed);
  const m: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      // Base slope toward bottom (r increases) plus two valley channels.
      const base = (rows - r) * 2;
      const valleyA = Math.exp(-Math.pow((c - cols * 0.25) / 2, 2)) * r * 1.2;
      const valleyB = Math.exp(-Math.pow((c - cols * 0.75) / 2, 2)) * r * 1.2;
      const noise = (rand() - 0.5) * 0.4;
      let z = base - Math.max(valleyA, valleyB) + noise;
      row.push(Math.round(z * 1000) / 1000);
    }
    m.push(row);
  }

  if (opts.flat && rows >= 6 && cols >= 6) {
    for (let r = 1; r <= 3; r++)
      for (let c = Math.floor(cols / 2) - 1; c <= Math.floor(cols / 2) + 1; c++)
        m[r][c] = 50;
  }

  if (opts.pit && rows >= 5 && cols >= 5) {
    const pr = Math.floor(rows / 2);
    const pc = Math.floor(cols / 2);
    m[pr][pc] = -5;
    // Ring higher so the pit is genuinely enclosed.
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = pr + dr;
        const cc = pc + dc;
        if (rr >= 0 && cc >= 0 && rr < rows && cc < cols)
          m[rr][cc] = Math.max(m[rr][cc], 8);
      }
  }

  const grid = gridFromMatrix(m, cellSize, null);
  if (opts.noDataHole && rows >= 7 && cols >= 7) {
    const cr = Math.floor(rows / 2);
    const cc = Math.floor(cols / 3);
    for (let dr = 0; dr <= 1; dr++)
      for (let dc = 0; dc <= 1; dc++) {
        const i = (cr + dr) * cols + (cc + dc);
        grid.mask[i] = 1;
        grid.elev[i] = NaN;
      }
  }
  return grid;
}
