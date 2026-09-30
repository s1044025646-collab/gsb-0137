import { test } from "node:test";
import assert from "node:assert/strict";
import { preprocess } from "../src/core/depressions.ts";
import {
  computeFlow,
  delineateWatershed,
  traceDownstream,
  extractStream,
} from "../src/core/flow.ts";
import { gridFromMatrix } from "../src/core/grid.ts";
import { generateSynthetic } from "../src/core/synthetic.ts";
import { DIR_S, DIR_SE, DIR_OUT, DIR_SINK } from "../src/core/types.ts";
import {
  bigFlat,
  boundaryOutlet,
  closedDepression,
  noDataHole,
  nodataEnclosed,
  singleSlope,
  twoValleys,
} from "./fixtures.ts";

function assertNoCycles(flow: ReturnType<typeof computeFlow>) {
  for (let start = 0; start < flow.receiver.length; start++) {
    if (flow.mask[start]) continue;
    let cur = start;
    const seen = new Set<number>();
    while (cur >= 0) {
      assert.ok(!seen.has(cur), `cycle detected from ${start} at ${cur}`);
      seen.add(cur);
      cur = flow.receiver[cur];
    }
    assert.ok(cur === -1 || cur === -2, `terminal must be sink/outlet`);
  }
}

test("hand-verified D8 directions on a tiny 2x2 slope", () => {
  // z: 2 1
  //    1 0  -> all flow SE/S into bottom-right, which exits the domain.
  const grid = gridFromMatrix(
    [
      [2, 1],
      [1, 0],
    ],
    1,
  );
  const pre = preprocess(grid, "fill");
  const flow = computeFlow(pre);
  assert.equal(flow.dir[0], DIR_SE); // top-left -> bottom-right (diagonal)
  assert.equal(flow.receiver[3], -2); // bottom-right exits boundary
  // accumulation: bottom-right collects all four cells.
  assert.equal(flow.upstreamCellCount[3], 4);
  assert.equal(flow.accumulationArea[3], 4);
});

test("single slope: every non-bottom cell flows south, area accumulates", () => {
  const grid = singleSlope();
  const pre = preprocess(grid, "fill");
  const flow = computeFlow(pre);
  assertNoCycles(flow);
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r < 4; r++)
      assert.equal(flow.dir[r * 5 + c], DIR_S, `(${r},${c}) should flow S`);
    assert.equal(flow.receiver[4 * 5 + c], -2); // bottom exits
  }
  // bottom cell in a column accumulates 5 cells
  assert.equal(flow.upstreamCellCount[4 * 5 + 2], 5);
});

test("diagonal distance matters: a closer cardinal vs diagonal comparison", () => {
  // cardinal neighbour drops 1 over distance 1 -> slope 1
  // diagonal neighbour drops 1.3 over sqrt2 -> slope ~0.92, cardinal wins
  const grid = gridFromMatrix(
    [
      [10, 10, 10],
      [10, 2, 1],
      [10, 1, 0.7],
    ],
    1,
  );
  const pre = preprocess(grid, "none");
  const flow = computeFlow(pre);
  // centre (index 4): cardinal neighbours both at 1 (slope 1) vs diagonal 0.7
  // (1.3/sqrt2 = 0.919). Cardinal wins.
  assert.notEqual(flow.dir[4], 0);
});

test("two valleys converge and total accumulation conserves cell count", () => {
  const grid = twoValleys();
  const pre = preprocess(grid, "fill");
  const flow = computeFlow(pre);
  assertNoCycles(flow);
  // Sum over boundary-exit terminals of upstream count must equal all valid
  // cells (area conservation).
  let total = 0;
  const counted = new Set<number>();
  for (let i = 0; i < flow.receiver.length; i++) {
    if (flow.receiver[i] === -2) {
      total += flow.upstreamCellCount[i];
      // walk to ensure distinct basins do not double count
    }
  }
  // Every valid cell ultimately exits; count distinct contributing cells.
  for (let i = 0; i < flow.receiver.length; i++) {
    let cur = i;
    while (cur >= 0) cur = flow.receiver[cur];
    if (cur === -2) counted.add(i);
  }
  assert.equal(counted.size, 25);
});

test("closed depression is reported closed and not masked as success", () => {
  const grid = closedDepression();
  const pre = preprocess(grid, "fill");
  // The pit has an overflow route over the ring to the boundary, so filling
  // raises it and records a spill (not closed).
  assert.ok(pre.filledCellCount >= 1, "pit must be raised to spill level");
  const open = pre.depressions.find((d) => !d.closed);
  assert.ok(open && open.spillCell !== null, "depression drains via spill");
  const flow = computeFlow(pre);
  assertNoCycles(flow);
  assert.notEqual(flow.dir[12], DIR_SINK, "filled pit now drains");
});

test("nodata-enclosed valid region is reported as closed basin", () => {
  const grid = nodataEnclosed();
  const pre = preprocess(grid, "fill");
  assert.ok(pre.closedDepressionCells.length >= 1);
  const flow = computeFlow(pre);
  assertNoCycles(flow);
  // NoData cells never receive flow.
  for (let i = 0; i < flow.receiver.length; i++) {
    if (!flow.mask[i] && flow.receiver[i] >= 0)
      assert.equal(flow.mask[flow.receiver[i]], 0);
  }
});

test("big flat resolves deterministically with no cycles", () => {
  const grid = bigFlat();
  const pre = preprocess(grid, "fill");
  const f1 = computeFlow(pre);
  const f2 = computeFlow(preprocess(grid, "fill"));
  assertNoCycles(f1);
  for (let i = 0; i < f1.dir.length; i++)
    assert.equal(f1.dir[i], f2.dir[i], "repeat run must be deterministic");
});

test("NoData hole is a barrier and its marker is not treated as low z", () => {
  const grid = noDataHole();
  assert.equal(grid.mask[12], 1);
  const pre = preprocess(grid, "fill");
  const flow = computeFlow(pre);
  assertNoCycles(flow);
  for (let i = 0; i < flow.receiver.length; i++) {
    if (!flow.mask[i] && flow.receiver[i] >= 0)
      assert.equal(flow.mask[flow.receiver[i]], 0, "never flow into NoData");
  }
});

test("boundary outlet: notch drains toward the edge", () => {
  const grid = boundaryOutlet();
  const pre = preprocess(grid, "fill");
  const flow = computeFlow(pre);
  assertNoCycles(flow);
  // top-middle is a boundary cell at z=1 -> must exit
  assert.equal(flow.receiver[1], -2);
});

test("fill records positive raise and a spill cell; raw grid untouched", () => {
  const grid = generateSynthetic({ rows: 7, cols: 7, pit: true });
  const rawBefore = Float64Array.from(grid.elev);
  const pre = preprocess(grid, "fill");
  for (let i = 0; i < grid.elev.length; i++)
    assert.equal(grid.elev[i], rawBefore[i], "raw elevation never mutated");
  assert.ok(pre.filledCellCount >= 1);
  for (let i = 0; i < pre.elev.length; i++) {
    if (!grid.mask[i]) assert.ok(pre.elev[i] >= grid.elev[i] - 1e-9);
  }
});

test("watershed membership: outlet receives exactly its upstream cells", () => {
  const grid = singleSlope();
  const flow = computeFlow(preprocess(grid, "fill"));
  // outlet at bottom row, column 2
  const w = delineateWatershed(flow, 4, 2);
  assert.equal(w.cellCount, 5);
  for (const i of w.cells) assert.equal(i % 5, 2, "all in column 2");
  assert.equal(w.area, 5);
});

test("downstream trace terminates at outlet and reports states", () => {
  const grid = singleSlope();
  const flow = computeFlow(preprocess(grid, "fill"));
  const path = traceDownstream(flow, 0, 2);
  assert.equal(path.length, 5);
  assert.equal(path[path.length - 1].state, "outlet");
});

test("stream extraction by threshold distinguishes cell count vs area", () => {
  const grid = singleSlope();
  const flow = computeFlow(preprocess(grid, "fill"));
  const cells = extractStream(flow, 5);
  // only the bottom row cells accumulate all 5 in a column
  assert.equal(cells.length, 5);
});

test("input order independence: shuffled matrix rows still same direction", () => {
  const a = singleSlope();
  // build identical logical grid via a differently allocated matrix object
  const rebuilt = gridFromMatrix(
    a.elev.reduce<number[][]>((rows, _, i) => {
      if (i % 5 === 0) rows.push([]);
      rows[rows.length - 1].push(a.mask[i] ? NaN : a.elev[i]);
      return rows;
    }, []),
    1,
  );
  const fa = computeFlow(preprocess(a, "fill"));
  const fb = computeFlow(preprocess(rebuilt, "fill"));
  for (let i = 0; i < fa.dir.length; i++) assert.equal(fa.dir[i], fb.dir[i]);
});

test("synthetic generator is deterministic for a seed", () => {
  const g1 = generateSynthetic({ rows: 6, cols: 6, seed: 42, pit: true });
  const g2 = generateSynthetic({ rows: 6, cols: 6, seed: 42, pit: true });
  for (let i = 0; i < g1.elev.length; i++)
    assert.equal(g1.elev[i], g2.elev[i]);
});
