import { idx, neighbors } from "./grid.ts";
import { DIR_OUT, DIR_SINK } from "./types.ts";
import type { FlowResult, PreprocessResult, WatershedResult } from "./types.ts";

const TOL = 1e-12;

/**
 * D8 flow direction.
 *
 *  - Slope to a neighbour is (z_i - z_j) / (d * cellSize) where d is the true
 *    centre-to-centre distance (1 cardinal, sqrt(2) diagonal), so diagonals
 *    are not unfairly penalised.
 *  - NoData cells are impassable barriers; they are never receivers.
 *  - A valid boundary cell may discharge OUTSIDE the domain (DIR_OUT): the
 *    edge of the modelled region is treated as an outlet, never as a wall.
 *  - Flats (no strictly lower neighbour) are resolved with a deterministic
 *    multi-source BFS: every cell that already has a downhill route (or that
    sits on the boundary) is a distance-0 anchor, and flat water flows toward
 *    the neighbour with the smallest distance label. Labels strictly decrease
 *    along every flat edge, hence no cycles.
 *  - A valid cell in a truly closed depression that has no anchor remains an
 *    internal sink (DIR_SINK) and is reported separately.
 */
export function computeFlow(pre: PreprocessResult): FlowResult {
  const { rows, cols, cellSize, elev, mask } = pre;
  const n = rows * cols;
  const dir = new Uint8Array(n);
  const receiver = new Int32Array(n).fill(-3);
  const label = new Int32Array(n).fill(-1);

  const valid = (i: number) => !mask[i];

  // Pass 1: strictly downhill receivers (true D8 slope) and anchors.
  for (let i = 0; i < n; i++) {
    if (!valid(i)) {
      receiver[i] = -3;
      continue;
    }
    const r = Math.floor(i / cols);
    const c = i % cols;
    let bestSlope = 0;
    let bestK = -1;
    let bestIndex = -1;
    let bestCode = 0;
    let boundaryCanExit = false;
    let boundaryK = -1;
    let boundaryCode = 0;
    for (const nb of neighbors(r, c, rows, cols)) {
      if (nb.outside) {
        if (boundaryK === -1) {
          boundaryK = nb.k;
          boundaryCode = nb.code;
        }
        boundaryCanExit = true;
        continue;
      }
      const j = nb.index;
      if (mask[j]) continue;
      const diff = elev[i] - elev[j];
      if (diff > TOL) {
        const slope = diff / (nb.dist * cellSize);
        if (slope > bestSlope) {
          bestSlope = slope;
          bestK = nb.k;
          bestIndex = j;
          bestCode = nb.code;
        }
      }
    }
    if (bestK !== -1) {
      receiver[i] = bestIndex;
      dir[i] = bestCode;
      label[i] = 0; // downhill anchor
    } else if (boundaryCanExit) {
      // Flat (or no lower neighbour) but on the boundary: discharge outside.
      receiver[i] = -2;
      dir[i] = DIR_OUT;
      label[i] = 0; // boundary anchor
      void boundaryK;
      void boundaryCode;
    } else {
      receiver[i] = -1; // unresolved flat / potential sink
    }
  }

  // Pass 2: multi-source BFS distance labels across equal-elevation flats.
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (valid(i) && label[i] === 0) queue.push(i);
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const r = Math.floor(i / cols);
    const c = i % cols;
    for (const nb of neighbors(r, c, rows, cols)) {
      if (nb.outside) continue;
      const j = nb.index;
      if (!valid(j)) continue;
      if (label[j] !== -1) continue;
      if (Math.abs(elev[j] - elev[i]) <= TOL) {
        label[j] = label[i] + 1;
        queue.push(j);
      }
    }
  }

  // Pass 3: route unresolved flat cells toward the neighbour with the
  // smallest distance label. Unlabelled cells are closed-basin sinks.
  for (let i = 0; i < n; i++) {
    if (!valid(i) || receiver[i] !== -1) continue;
    const r = Math.floor(i / cols);
    const c = i % cols;
    let bestLabel = Infinity;
    let bestIndex = -1;
    let bestCode = 0;
    for (const nb of neighbors(r, c, rows, cols)) {
      if (nb.outside) continue;
      const j = nb.index;
      if (!valid(j)) continue;
      if (Math.abs(elev[j] - elev[i]) > TOL) continue;
      if (label[j] !== -1 && label[j] < bestLabel) {
        bestLabel = label[j];
        bestIndex = j;
        bestCode = nb.code;
      }
    }
    if (bestIndex !== -1 && bestLabel < label[i] && label[i] > 0) {
      receiver[i] = bestIndex;
      dir[i] = bestCode;
    } else if (bestIndex !== -1) {
      // label[i] is -1 but a labelled equal neighbour exists.
      receiver[i] = bestIndex;
      dir[i] = bestCode;
    } else {
      receiver[i] = -1;
      dir[i] = DIR_SINK;
    }
  }

  // Upstream accumulation via topological (Kahn) order so each receiver is
  // updated only after all of its contributors.
  const upstreamCellCount = new Float64Array(n);
  const indeg = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (!valid(i)) continue;
    upstreamCellCount[i] = 1; // the cell itself
    const j = receiver[i];
    if (j >= 0) indeg[j]++;
  }
  const q: number[] = [];
  for (let i = 0; i < n; i++) if (valid(i) && indeg[i] === 0) q.push(i);
  let qh = 0;
  while (qh < q.length) {
    const i = q[qh++];
    const j = receiver[i];
    if (j >= 0) {
      upstreamCellCount[j] += upstreamCellCount[i];
      if (--indeg[j] === 0) q.push(j);
    }
  }
  // Cells left with positive indegree are within closed sink subgraphs that
  // Kahn could not finish. Drain them into their sink.
  for (let i = 0; i < n; i++) {
    if (!valid(i)) continue;
    if (indeg[i] > 0) {
      // Defensive: flatten any residual cycle toward the local lowest cell.
      resolveResidual(i, receiver, dir, elev, mask, rows, cols, indeg);
    }
  }

  const accumulationArea = new Float64Array(n);
  const area = cellSize * cellSize;
  for (let i = 0; i < n; i++)
    accumulationArea[i] = upstreamCellCount[i] * area;

  return {
    rows,
    cols,
    cellSize,
    dir,
    receiver,
    upstreamCellCount,
    accumulationArea,
    mask,
  };
}

function resolveResidual(
  start: number,
  receiver: Int32Array,
  dir: Uint8Array,
  elev: Float64Array,
  mask: Uint8Array,
  rows: number,
  cols: number,
  indeg: Int32Array,
): void {
  // Walk to the lowest reachable cell in the residual component and make all
  // visited cells point toward it in descending order. Deterministic.
  const seen = new Set<number>();
  let cur = start;
  while (receiver[cur] >= 0 && !seen.has(cur)) {
    seen.add(cur);
    cur = receiver[cur];
  }
  let sink = cur;
  for (const i of seen) if (elev[i] < elev[sink]) sink = i;
  for (const i of seen) {
    if (i === sink) {
      receiver[i] = -1;
      dir[i] = DIR_SINK;
    } else {
      const r = Math.floor(i / cols);
      const c = i % cols;
      for (const nb of neighbors(r, c, rows, cols)) {
        if (nb.outside || mask[nb.index]) continue;
        if (nb.index === sink) {
          receiver[i] = sink;
          dir[i] = nb.code;
          break;
        }
      }
    }
    indeg[i] = 0;
  }
}

/** Trace the downstream path of one cell until outside/sink/loop. */
export function traceDownstream(
  flow: FlowResult,
  row: number,
  col: number,
): Array<{ row: number; col: number; state: string }> {
  const { cols, receiver, mask, rows } = flow;
  const start = idx(row, col, cols);
  if (row < 0 || col < 0 || row >= rows || col >= cols)
    throw new Error("coordinates outside grid");
  if (mask[start]) throw new Error("cell is NoData");
  const path: Array<{ row: number; col: number; state: string }> = [];
  const visited = new Set<number>();
  let cur = start;
  while (cur >= 0) {
    if (visited.has(cur)) {
      path.push({
        row: Math.floor(cur / cols),
        col: cur % cols,
        state: "cycle",
      });
      break;
    }
    visited.add(cur);
    const r = Math.floor(cur / cols);
    const c = cur % cols;
    const next = receiver[cur];
    if (next === -2) {
      path.push({ row: r, col: c, state: "outlet" });
      break;
    }
    if (next === -1) {
      path.push({ row: r, col: c, state: "sink" });
      break;
    }
    path.push({ row: r, col: c, state: "through" });
    cur = next;
  }
  return path;
}

/**
 * Delineate the watershed (contributing area) of a specified outlet cell:
 * every cell whose flow path eventually reaches it.
 */
export function delineateWatershed(
  flow: FlowResult,
  row: number,
  col: number,
): WatershedResult {
  const { rows, cols, receiver, mask, cellSize } = flow;
  const outlet = idx(row, col, cols);
  if (row < 0 || col < 0 || row >= rows || col >= cols)
    throw new Error("coordinates outside grid");
  if (mask[outlet]) throw new Error("outlet cell is NoData");

  const members = new Set<number>([outlet]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < rows * cols; i++) {
      if (mask[i] || members.has(i)) continue;
      if (receiver[i] >= 0 && members.has(receiver[i])) {
        members.add(i);
        changed = true;
      }
    }
  }
  const cells = [...members].sort((a, b) => a - b);
  const unreached: number[] = [];
  for (let i = 0; i < rows * cols; i++) {
    if (!mask[i] && !members.has(i)) unreached.push(i);
  }
  return {
    outletIndex: outlet,
    cells,
    cellCount: cells.length,
    area: cells.length * cellSize * cellSize,
    unreached,
  };
}

/** Cells whose upstream area meets/exceeds a threshold (stream network). */
export function extractStream(
  flow: FlowResult,
  thresholdCells: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < flow.upstreamCellCount.length; i++) {
    if (!flow.mask[i] && flow.upstreamCellCount[i] >= thresholdCells)
      out.push(i);
  }
  return out;
}
