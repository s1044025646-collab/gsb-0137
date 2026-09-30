#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, closeDatabase } from "../db/database.ts";
import {
  getReport,
  getTerrain,
  listAnalyses,
  loadAnalysis,
  loadTerrainGrid,
  runAnalysis,
  saveTerrain,
  tracePath,
} from "../db/repository.ts";
import { gridFromMatrix } from "../core/grid.ts";
import { generateSynthetic } from "../core/synthetic.ts";
import { preprocess } from "../core/depressions.ts";
import { buildMatrix, MATRIX_KINDS, toCSV } from "../core/exporters.ts";

const DB_PATH = process.env.TWSH_DB ?? resolve("data/app.sqlite");

function usage(): void {
  console.log(`twsh - raster terrain flow & watershed CLI

Usage:
  twsh import <name> <file.json> [--cell-size N] [--nodata V]
  twsh synthetic <name> <rows> <cols> [--seed N] [--pit] [--hole] [--flat] [--cell-size N]
  twsh depressions <terrainId> [fill|breach|none]
  twsh analyze <terrainId> [--strategy fill] [--threshold N] [--outlet r,c ...] [--key K]
  twsh analyses <terrainId>
  twsh report <analysisId>
  twsh trace <analysisId> <row> <col>
  twsh watershed <analysisId>
  twsh compare <terrainId> <t1> <t2> [t3 ...]
  twsh export <analysisId> <kind> [--out file] [--csv] [--outlet cellIndex]

kinds: ${MATRIX_KINDS.join(", ")}
`);
}

function parseFlags(args: string[]): {
  positional: string[];
  flags: Map<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) flags.set(key, true);
      else {
        flags.set(key, next);
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function num(f: Map<string, string | boolean>, k: string, dflt: number): number {
  const v = f.get(k);
  return v === undefined || typeof v === "boolean" ? dflt : Number(v);
}

function readMatrixFile(file: string): number[][] {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error("file must contain a JSON 2D array");
  return raw;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }
  mkdirSync(resolve("data"), { recursive: true });
  const db = openDatabase(DB_PATH);
  try {
    await dispatch(cmd, rest, db);
  } finally {
    closeDatabase(db);
  }
}

async function dispatch(cmd: string, rest: string[], db: ReturnType<typeof openDatabase>): Promise<void> {
  const { positional, flags } = parseFlags(rest);
  switch (cmd) {
    case "import": {
      const [name, file] = positional;
      const cellSize = num(flags, "cell-size", 10);
      const ndFlag = flags.get("nodata");
      const noDataValue =
        ndFlag === undefined || typeof ndFlag === "boolean"
          ? null
          : Number(ndFlag);
      const matrix = readMatrixFile(file);
      const grid = gridFromMatrix(matrix, cellSize, noDataValue);
      console.log(
        `BEFORE import: grid ${grid.rows}x${grid.cols}, cellSize=${cellSize}, NoData value=${noDataValue ?? "none"}`,
      );
      const rec = saveTerrain(db, name, grid, () => new Date().toISOString());
      console.log(
        `AFTER  import: terrain id=${rec.id} name="${rec.name}" validCells=${rec.validCells}/${grid.rows * grid.cols}`,
      );
      break;
    }
    case "synthetic": {
      const [name, rowsS, colsS] = positional;
      const grid = generateSynthetic({
        rows: Number(rowsS),
        cols: Number(colsS),
        cellSize: num(flags, "cell-size", 10),
        seed: num(flags, "seed", 1),
        pit: flags.get("pit") === true,
        noDataHole: flags.get("hole") === true,
        flat: flags.get("flat") === true,
      });
      const rec = saveTerrain(db, name, grid, () => new Date().toISOString());
      console.log(
        `synthetic terrain id=${rec.id} ${grid.rows}x${grid.cols} validCells=${rec.validCells}`,
      );
      break;
    }
    case "depressions": {
      const terrainId = Number(positional[0]);
      const strategy = (positional[1] as "fill" | "breach" | "none") ?? "fill";
      const before = getTerrain(db, terrainId);
      const grid = loadTerrainGrid(db, terrainId);
      const pre = preprocess(grid, strategy);
      const closed = pre.depressions.filter((d) => d.closed);
      console.log(
        `terrain ${before.id} "${before.name}" strategy=${strategy}`,
      );
      console.log(
        `BEFORE: depressions(raw) check via strategy output`,
      );
      console.log(
        `AFTER : filledCells=${pre.filledCellCount} fillVolume=${pre.fillVolume.toFixed(3)}m3 closedBasins=${closed.length} closedCells=${pre.closedDepressionCells.length}`,
      );
      for (const d of pre.depressions) {
        const [pr, pc] = [
          Math.floor(d.pourPoint / grid.cols),
          d.pourPoint % grid.cols,
        ];
        console.log(
          `  - pour=(${pr},${pc}) cells=${d.cellCount} closed=${d.closed} spillElev=${d.spillElevation ?? "n/a"}`,
        );
      }
      if (closed.length > 0) {
        console.log(
          `WARNING: ${closed.length} closed valid region(s) have no external spill path and remain internal sinks.`,
        );
      }
      break;
    }
    case "analyze": {
      const terrainId = Number(positional[0]);
      const strategy = (flags.get("strategy") as string) ?? "fill";
      const threshold = num(flags, "threshold", 1);
      const outletVals = flags.get("outlet");
      const outlets =
        typeof outletVals === "string"
          ? outletVals
              .split(";")
              .map((s) => s.split(",").map(Number))
              .map(([row, col]) => ({ row, col }))
          : [];
      const keyFlag = flags.get("key");
      const requestKey = typeof keyFlag === "string" ? keyFlag : undefined;
      const t = getTerrain(db, terrainId);
      console.log(
        `BEFORE analyze: terrain=${t.id} strategy=${strategy} threshold=${threshold} outlets=${outlets.length}`,
      );
      const full = runAnalysis(
        db,
        terrainId,
        { fillStrategy: strategy as never, threshold, outlets },
        () => new Date().toISOString(),
        requestKey,
      );
      console.log(
        `AFTER  analyze: analysis=${full.summary.id} status=${full.summary.status} streamCells=${full.summary.streamCellCount} closedCells=${full.summary.closedCells}`,
      );
      break;
    }
    case "analyses": {
      const terrainId = Number(positional[0]);
      const r = listAnalyses(db, terrainId, 200, 0);
      console.log(`analyses for terrain ${terrainId}: ${r.total}`);
      for (const a of r.items)
        console.log(
          `  #${a.id} strategy=${a.fillStrategy} threshold=${a.threshold} outlets=[${a.outletCells.join(",")}] status=${a.status}`,
        );
      break;
    }
    case "report": {
      const id = Number(positional[0]);
      console.log(JSON.stringify(getReport(db, id), null, 2));
      break;
    }
    case "trace": {
      const [idS, rS, cS] = positional;
      const path = tracePath(db, Number(idS), Number(rS), Number(cS));
      console.log(`downstream path from (${rS},${cS}):`);
      for (const p of path) console.log(`  (${p.row},${p.col}) ${p.state}`);
      break;
    }
    case "watershed": {
      const id = Number(positional[0]);
      const full = loadAnalysis(db, id);
      for (const w of full.watersheds) {
        console.log(
          `outlet cell=${w.outletCell} (${Math.floor(w.outletCell / full.flow.cols)},${w.outletCell % full.flow.cols}) cells=${w.cellCount} area=${w.area.toFixed(2)}m2`,
        );
      }
      break;
    }
    case "compare": {
      const terrainId = Number(positional[0]);
      const thresholds = positional.slice(1).map(Number);
      const grid = loadTerrainGrid(db, terrainId);
      console.log(`threshold comparison for terrain ${terrainId}`);
      for (const t of thresholds) {
        const full = runAnalysis(
          db,
          terrainId,
          { fillStrategy: "fill", threshold: t, outlets: [] },
          () => new Date().toISOString(),
          `compare-${t}`,
        );
        console.log(
          `  threshold=${t} cells (>=${t}) -> streamCells=${full.streamCells.length} area=${(full.streamCells.length * grid.cellSize * grid.cellSize).toFixed(1)}m2 analysis=${full.summary.id}`,
        );
      }
      break;
    }
    case "export": {
      const [idS, kind] = positional;
      const id = Number(idS);
      const full = loadAnalysis(db, id);
      const terrain = getTerrain(db, full.summary.terrainId);
      const outletFlag = flags.get("outlet");
      const em = buildMatrix(
        full,
        { rows: terrain.rows, cols: terrain.cols },
        kind as never,
        typeof outletFlag === "string" ? Number(outletFlag) : undefined,
      );
      const asCsv = flags.get("csv") === true;
      const outFlag = flags.get("out");
      const content = asCsv ? toCSV(em) : JSON.stringify(em, null, 2);
      if (typeof outFlag === "string") {
        writeFileSync(resolve(outFlag), content);
        console.log(`wrote ${kind} matrix to ${outFlag}`);
      } else console.log(content);
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
