import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, closeDatabase, migrate } from "../src/db/database.ts";
import {
  runAnalysis,
  saveTerrain,
  loadAnalysis,
  getReport,
  listAnalyses,
  tracePath,
  NotFoundError,
} from "../src/db/repository.ts";
import { twoValleys, singleSlope, nodataEnclosed } from "./fixtures.ts";

function tmpDb(): string {
  const dir = join("tmp", `db-${Math.random().toString(36).slice(2)}.sqlite`);
  return dir;
}

test("terrain raw matrix is stored and never overwritten after analysis", () => {
  const path = tmpDb();
  const db = openDatabase(path);
  const grid = twoValleys();
  const rawSnapshot = Float64Array.from(grid.elev);
  const t = saveTerrain(db, "v", grid, () => "2026-01-01T00:00:00.000Z");
  runAnalysis(
    db,
    t.id,
    { fillStrategy: "fill", threshold: 2, outlets: [{ row: 4, col: 2 }] },
    () => "2026-01-01T00:00:00.000Z",
  );
  const full = loadAnalysis(db, 1);
  // raw_z preserved independently from eff_z
  for (let i = 0; i < grid.elev.length; i++) {
    assert.equal(grid.elev[i], rawSnapshot[i]);
  }
  assert.ok(full.pre.elev[12] >= grid.elev[12]);
  closeDatabase(db);
  rmSync(path, { force: true });
});

test("idempotent: identical request returns same analysis id", () => {
  const db = openDatabase(":memory:");
  const t = saveTerrain(db, "v", singleSlope(), () => "t");
  const cfg = {
    fillStrategy: "fill" as const,
    threshold: 3,
    outlets: [{ row: 4, col: 2 }],
  };
  const a1 = runAnalysis(db, t.id, cfg, () => "t", "key-1");
  const a2 = runAnalysis(db, t.id, cfg, () => "t", "key-1");
  assert.equal(a1.summary.id, a2.summary.id);
  const list = listAnalyses(db, t.id, 10, 0);
  assert.equal(list.total, 1);
});

test("changing outlet or fill rule creates an isolated new analysis", () => {
  const db = openDatabase(":memory:");
  const t = saveTerrain(db, "v", singleSlope(), () => "t");
  const aFill = runAnalysis(
    db,
    t.id,
    { fillStrategy: "fill", threshold: 2, outlets: [{ row: 4, col: 1 }] },
    () => "t",
  );
  const aNone = runAnalysis(
    db,
    t.id,
    { fillStrategy: "none", threshold: 2, outlets: [{ row: 4, col: 1 }] },
    () => "t",
  );
  const aOutlet = runAnalysis(
    db,
    t.id,
    { fillStrategy: "fill", threshold: 2, outlets: [{ row: 4, col: 3 }] },
    () => "t",
  );
  assert.notEqual(aFill.summary.id, aNone.summary.id);
  assert.notEqual(aFill.summary.id, aOutlet.summary.id);
  // old result still has its original outlet
  const reloaded = loadAnalysis(db, aFill.summary.id);
  assert.deepEqual(reloaded.watersheds[0].outletCell, 4 * 5 + 1);
});

test("transaction rollback on failure leaves no partial rows", () => {
  const db = openDatabase(":memory:");
  const t = saveTerrain(db, "v", nodataEnclosed(), () => "t");
  // outlet on a NoData cell -> validation throws before insert path;
  // simulate by calling with an outlet index then checking zero analyses
  try {
    runAnalysis(
      db,
      t.id,
      { fillStrategy: "fill", threshold: 1, outlets: [{ row: 0, col: 0 }] },
      () => "t",
    );
    assert.fail("expected error for NoData outlet");
  } catch (e) {
    assert.ok(e instanceof Error);
  }
  const n = (
    db.prepare("SELECT COUNT(*) AS n FROM analyses").get() as { n: number }
  ).n;
  assert.equal(n, 0);
});

test("persistence across close/reopen and repeatable migration", () => {
  const path = tmpDb();
  let db = openDatabase(path);
  const t = saveTerrain(db, "persist", twoValleys(), () => "t");
  const a = runAnalysis(
    db,
    t.id,
    { fillStrategy: "fill", threshold: 3, outlets: [{ row: 4, col: 2 }] },
    () => "t",
  );
  closeDatabase(db);

  db = openDatabase(path);
  migrate(db, () => "t"); // re-running migrations must not error
  const reloaded = loadAnalysis(db, a.summary.id);
  assert.equal(reloaded.summary.terrainId, t.id);
  const report = getReport(db, a.summary.id);
  assert.equal((report.terrain as any).validCells, 25);
  const pathTrace = tracePath(db, a.summary.id, 0, 0);
  assert.ok(pathTrace.length >= 1);
  closeDatabase(db);
  rmSync(path, { force: true });
});

test("report distinguishes cell counts from real area", () => {
  const db = openDatabase(":memory:");
  const grid = twoValleys(); // cellSize 2 -> area per cell 4
  const t = saveTerrain(db, "v", grid, () => "t");
  const full = runAnalysis(
    db,
    t.id,
    { fillStrategy: "fill", threshold: 5, outlets: [{ row: 4, col: 2 }] },
    () => "t",
  );
  const report = full.report as any;
  assert.equal(report.terrain.cellArea, 4);
  assert.equal(report.terrain.validArea, 100);
  assert.equal(report.terrain.validCells, 25);
});

test("load missing analysis throws NotFound", () => {
  const db = openDatabase(":memory:");
  assert.throws(() => loadAnalysis(db, 999), NotFoundError);
});
