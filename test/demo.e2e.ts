/**
 * Reproducible end-to-end demo. Runs entirely against an isolated database in
 * tmp/, exercises CLI-style operations through the repository, and verifies
 * the computed results. No network, no randomness.
 *
 *   node --experimental-sqlite test/demo.e2e.ts
 */
import { rmSync } from "node:fs";
import assert from "node:assert/strict";
import { openDatabase, closeDatabase } from "../src/db/database.ts";
import {
  runAnalysis,
  saveTerrain,
  loadAnalysis,
} from "../src/db/repository.ts";
import { generateSynthetic } from "../src/core/synthetic.ts";
import { preprocess } from "../src/core/depressions.ts";
import { computeFlow, traceDownstream } from "../src/core/flow.ts";

const DB_PATH = "tmp/demo.sqlite";

function main(): void {
  rmSync(DB_PATH, { force: true });
  const db = openDatabase(DB_PATH);
  const fixedNow = () => "2026-09-29T00:00:00.000Z";

  console.log("== 1. Generate synthetic terrain (seed=7, pit + flat) ==");
  const grid = generateSynthetic({
    rows: 10,
    cols: 10,
    cellSize: 5,
    seed: 7,
    pit: true,
    flat: true,
  });
  const t = saveTerrain(db, "demo-terrain", grid, fixedNow);
  console.log(`   terrain id=${t.id} valid=${t.validCells}/${100}`);

  console.log("== 2. Inspect depressions (fill) ==");
  const pre = preprocess(grid, "fill");
  console.log(
    `   filledCells=${pre.filledCellCount} fillVolume=${pre.fillVolume.toFixed(2)}m3 closed=${pre.closedDepressionCells.length}`,
  );
  for (const d of pre.depressions) {
    console.log(
      `   pour=${d.pourPoint} closed=${d.closed} spillElev=${d.spillElevation ?? "n/a"} cells=${d.cellCount}`,
    );
  }

  console.log("== 3. D8 flow + accumulation ==");
  const flow = computeFlow(pre);
  const maxAcc = Math.max(...flow.accumulationArea);
  console.log(`   max contributing area = ${maxAcc.toFixed(1)} m2`);

  console.log("== 4. Persist analysis with outlet at bottom edge ==");
  const outlet = { row: 9, col: 2 };
  const full = runAnalysis(
    db,
    t.id,
    { fillStrategy: "fill", threshold: 8, outlets: [outlet] },
    fixedNow,
    "demo-key",
  );
  console.log(
    `   analysis id=${full.summary.id} streamCells=${full.streamCells.length}`,
  );

  console.log("== 5. Idempotent repeat ==");
  const again = runAnalysis(
    db,
    t.id,
    { fillStrategy: "fill", threshold: 8, outlets: [outlet] },
    fixedNow,
    "demo-key",
  );
  assert.equal(again.summary.id, full.summary.id);
  console.log(`   same analysis id=${again.summary.id}`);

  console.log("== 6. Downstream trace ==");
  const path = traceDownstream(loadAnalysis(db, full.summary.id).flow, 0, 0);
  console.log(
    `   path length=${path.length} terminal=${path[path.length - 1].state}`,
  );

  console.log("== 7. Report (machine-readable) ==");
  const report = full.report as any;
  console.log(
    `   validArea=${report.terrain.validArea}m2 sinkCount=${report.flow.sinkCount} outlets=${report.watersheds.length}`,
  );

  closeDatabase(db);

  console.log("== 8. Restart persistence ==");
  const db2 = openDatabase(DB_PATH);
  const reloaded = loadAnalysis(db2, full.summary.id);
  assert.equal(reloaded.summary.id, full.summary.id);
  assert.equal(reloaded.streamCells.length, full.streamCells.length);
  console.log(`   reloaded analysis id=${reloaded.summary.id} OK`);
  closeDatabase(db2);

  console.log("\nDEMO OK - all assertions passed.");
}

main();
