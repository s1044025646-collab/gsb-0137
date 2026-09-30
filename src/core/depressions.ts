import { MinHeap } from "./heap.ts";
import { idx, neighbors } from "./grid.ts";
import type {
  DepressionRecord,
  ElevationGrid,
  FillStrategy,
  PreprocessResult,
} from "./types.ts";
import {
  SOURCE_BREACHED,
  SOURCE_CLOSED,
  SOURCE_FILLED,
  SOURCE_FLAT_RESOLVED,
  SOURCE_NODATA,
  SOURCE_UNTOUCHED,
} from "./types.ts";

const EPS = 1e-9;

/**
 * Depression handling.
 *
 * `fill` uses a Priority-Flood (Barnes 2014 style): the effective surface is
 * initialised to +Infinity, every valid boundary cell is seeded at its raw
 * elevation, and a min-heap expands inward. A cell that is lower than the
 * lowest neighbour already processed is raised to that neighbour's level plus
 * an infinitesimal epsilon so it keeps a strictly downhill path (no flat
 * loops). The raw grid is never modified.
 *
 * A valid region that is completely enclosed by NoData (or by higher ground
 * with no boundary spill) is reported as closed and left as an internal sink;
 * it is never arbitrarily perturbed.
 *
 * `breach` instead lowers cells along a straight carved path from the lowest
 * point of each depression to the nearest boundary.
 */
export function preprocess(
  grid: ElevationGrid,
  strategy: FillStrategy,
): PreprocessResult {
  const { rows, cols, cellSize, elev: raw, mask } = grid;
  const n = rows * cols;
  const eff = new Float64Array(n);
  const source = new Uint8Array(n);
  const delta = new Float32Array(n);
  eff.fill(Infinity);

  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      source[i] = SOURCE_NODATA;
      eff[i] = NaN;
    }
  }

  if (strategy === "none") {
    for (let i = 0; i < n; i++) {
      if (!mask[i]) {
        eff[i] = raw[i];
        source[i] = SOURCE_UNTOUCHED;
      }
    }
    return finalize(
      grid,
      eff,
      source,
      delta,
      strategy,
      [],
      0,
      0,
      [],
    );
  }

  if (strategy === "breach") {
    return breach(grid, eff, source, delta);
  }
  return fill(grid, eff, source, delta);
}

function fill(
  grid: ElevationGrid,
  eff: Float64Array,
  source: Uint8Array,
  delta: Float32Array,
): PreprocessResult {
  const { rows, cols, cellSize, elev: raw, mask } = grid;
  const n = rows * cols;
  const heap = new MinHeap();
  const visited = new Uint8Array(n);

  // Seed every valid boundary cell. NoData boundary cells are not seeds
  // (they are barriers, not outlets).
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r !== 0 && c !== 0 && r !== rows - 1 && c !== cols - 1) continue;
      const i = idx(r, c, cols);
      if (mask[i]) continue;
      eff[i] = raw[i];
      source[i] = SOURCE_UNTOUCHED;
      heap.push(raw[i], i);
      visited[i] = 1;
    }
  }

  const depressions: DepressionRecord[] = [];
  const closed: number[] = [];
  const spillOf = new Int32Array(n).fill(-1);
  const spillElev = new Float64Array(n);
  let filledCellCount = 0;
  let fillVolume = 0;

  while (heap.size > 0) {
    const i = heap.pop();
    const r = Math.floor(i / cols);
    const c = i % cols;
    const nbrs = neighbors(r, c, rows, cols);
    for (const nb of nbrs) {
      if (nb.outside) continue;
      const j = nb.index;
      if (mask[j] || visited[j]) continue;
      visited[j] = 1;
      const target = eff[i] + EPS;
      if (raw[j] < eff[i]) {
        // Depression cell: raise to the pour level.
        eff[j] = target;
        source[j] = SOURCE_FILLED;
        delta[j] = target - raw[j];
        filledCellCount++;
        fillVolume += delta[j] * cellSize * cellSize;
        spillOf[j] = i;
        spillElev[j] = eff[i];
      } else {
        eff[j] = raw[j];
        source[j] = SOURCE_UNTOUCHED;
      }
      heap.push(eff[j], j);
    }
  }

  // Any valid cell never reached is enclosed by NoData (barrier) and has no
  // boundary outlet: a closed basin.
  for (let i = 0; i < n; i++) {
    if (mask[i]) continue;
    if (!visited[i]) {
      closed.push(i);
      source[i] = SOURCE_CLOSED;
      eff[i] = raw[i];
    }
  }

  // Build depression records by grouping filled cells that share a spill.
  const groups = new Map<number, number[]>();
  for (let j = 0; j < n; j++) {
    if (source[j] !== SOURCE_FILLED) continue;
    const s = spillOf[j];
    if (s < 0) continue;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(j);
  }
  for (const [spillCell, raised] of groups) {
    const pourPoint = raised.reduce((a, b) => (raw[a] < raw[b] ? a : b));
    depressions.push({
      pourPoint,
      spillCell,
      spillElevation: spillElev[spillCell],
      cellCount: raised.length,
      closed: false,
      raisedCells: raised.slice(0, 64),
    });
  }
  if (closed.length > 0) {
    const pourPoint = closed.reduce((a, b) => (raw[a] < raw[b] ? a : b));
    depressions.push({
      pourPoint,
      spillCell: null,
      spillElevation: null,
      cellCount: closed.length,
      closed: true,
      raisedCells: [],
    });
  }

  return finalize(
    grid,
    eff,
    source,
    delta,
    "fill",
    closed,
    filledCellCount,
    fillVolume,
    depressions,
  );
}

function breach(
  grid: ElevationGrid,
  eff: Float64Array,
  source: Uint8Array,
  delta: Float32Array,
): PreprocessResult {
  const { rows, cols, cellSize, elev: raw, mask } = grid;
  // Start from raw valid surface.
  for (let i = 0; i < rows * cols; i++) {
    if (!mask[i]) {
      eff[i] = raw[i];
      source[i] = SOURCE_UNTOUCHED;
    }
  }
  const depressions: DepressionRecord[] = [];
  const closed: number[] = [];

  // Find raw sinks: valid cells whose every valid neighbour is higher.
  const sinks: number[] = [];
  for (let i = 0; i < rows * cols; i++) {
    if (mask[i]) continue;
    const r = Math.floor(i / cols);
    const c = i % cols;
    let lowest = true;
    for (const nb of neighbors(r, c, rows, cols)) {
      if (nb.outside || mask[nb.index]) continue;
      if (raw[nb.index] <= raw[i] - EPS) {
        lowest = false;
        break;
      }
    }
    if (lowest) sinks.push(i);
  }

  for (const sink of sinks) {
    const sr = Math.floor(sink / cols);
    const sc = sink % cols;
    // Nearest boundary by Manhattan distance.
    const br =
      sr <= rows - 1 - sr
        ? 0
        : rows - 1;
    const bc =
      sc <= cols - 1 - sc
        ? 0
        : cols - 1;
    const path = carvePath(sr, sc, br, bc, rows, cols, mask);
    if (path === null) {
      closed.push(sink);
      source[sink] = SOURCE_CLOSED;
      depressions.push({
        pourPoint: sink,
        spillCell: null,
        spillElevation: null,
        cellCount: 1,
        closed: true,
        raisedCells: [],
      });
      continue;
    }
    // Lower each path cell to just below the previous so water drains out.
    let level = raw[sink];
    for (let k = 0; k < path.length; k++) {
      const j = path[k];
      if (k === 0) {
        eff[j] = raw[sink];
      } else {
        level = Math.min(level, raw[j]);
        eff[j] = raw[sink] - (path.length - k) * EPS;
      }
      if (source[j] === SOURCE_UNTOUCHED) source[j] = SOURCE_BREACHED;
      delta[j] = eff[j] - raw[j];
    }
    depressions.push({
      pourPoint: sink,
      spillCell: path[path.length - 1],
      spillElevation: eff[path[path.length - 1]],
      cellCount: path.length,
      closed: false,
      raisedCells: [],
    });
  }

  return finalize(
    grid,
    eff,
    source,
    delta,
    "breach",
    closed,
    0,
    0,
    depressions,
  );
}

/**
 * Carve a monotone path from (sr,sc) to the target boundary cell, stepping
 * one row then one column. Returns null if every route is blocked by NoData.
 */
function carvePath(
  sr: number,
  sc: number,
  br: number,
  bc: number,
  rows: number,
  cols: number,
  mask: Uint8Array,
): number[] | null {
  const path: number[] = [];
  let r = sr;
  let c = sc;
  const dr = Math.sign(br - sr);
  const dc = Math.sign(bc - sc);
  const step = (): boolean => {
    if (r !== br) r += dr;
    else if (c !== bc) c += dc;
    else return false;
    const i = idx(r, c, cols);
    if (mask[i]) return false;
    path.push(i);
    return true;
  };
  if (!mask[idx(sr, sc, cols)]) path.push(idx(sr, sc, cols));
  while (r !== br || c !== bc) {
    if (!step()) return null;
  }
  return path;
}

function finalize(
  grid: ElevationGrid,
  eff: Float64Array,
  source: Uint8Array,
  delta: Float32Array,
  strategy: FillStrategy,
  closed: number[],
  filledCellCount: number,
  fillVolume: number,
  depressions: DepressionRecord[] = [],
): PreprocessResult {
  // Raw flat cells that were never raised get a deterministic flow tag later
  // in routing; mark them here for provenance.
  for (let i = 0; i < eff.length; i++) {
    if (!grid.mask[i] && source[i] === SOURCE_UNTOUCHED) {
      // detect raw flat: a valid neighbour with equal raw elevation
      const r = Math.floor(i / grid.cols);
      const c = i % grid.cols;
      for (const nb of neighbors(r, c, grid.rows, grid.cols)) {
        if (nb.outside || grid.mask[nb.index]) continue;
        if (grid.elev[nb.index] === grid.elev[i]) {
          source[i] = SOURCE_FLAT_RESOLVED;
          break;
        }
      }
    }
  }
  return {
    rows: grid.rows,
    cols: grid.cols,
    cellSize: grid.cellSize,
    elev: eff,
    mask: grid.mask,
    source,
    delta,
    strategy,
    closedDepressionCells: closed,
    filledCellCount,
    fillVolume,
    depressions,
  };
}
