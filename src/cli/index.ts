#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/database.js";
import { Repository } from "../db/repository.js";
import { HydroService } from "../api/service.js";
import { buildGrid } from "../core/grid.js";
import { findPits, gridStats } from "../core/inspect.js";
import { generateDem, gridToRows } from "../core/generator.js";

interface CliFlags {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: CliFlags } {
  const flags: CliFlags = {};
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = true;
    } else positional.push(arg);
  }
  return { cmd: positional[0] ?? "help", positional: positional.slice(1), flags };
}

function reqFlag(flags: CliFlags, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required flag --${name}`);
  }
  return v;
}

function printMatrix(title: string, m: unknown[][], nodata = "·"): void {
  console.log(`\n${title}`);
  for (const row of m) {
    console.log(
      row
        .map((v) => (v === null ? nodata.padStart(5) : String(v).padStart(5)))
        .join(" "),
    );
  }
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  const dbPath = (flags.db as string) ?? join(process.cwd(), ".run", "hydro.db");
  const db = openDatabase(dbPath);
  const repo = new Repository(db);
  const service = new HydroService(repo);
  const json = flags.json === true;

  try {
    switch (cmd) {
      case "help":
        console.log(USAGE);
        break;

      case "import": {
        const file = reqFlag(flags, "file");
        const name = (flags.name as string) ?? file;
        const payload = JSON.parse(readFileSync(file, "utf8"));
        const before = repo.listTerrains(1, 0).total;
        const grid = buildGrid(payload.nrows, payload.ncols, payload.cellSize, payload.rows);
        console.log(`BEFORE: ${before} terrain(s); importing ${grid.nrows}x${grid.ncols} (cell=${grid.cellSize})`);
        const row = repo.insertTerrain(name, grid);
        const after = repo.listTerrains(1, 0).total;
        console.log(`AFTER:  ${after} terrain(s); imported terrain id=${row.id}`, JSON.stringify(gridStats(grid)));
        if (json) console.log(JSON.stringify({ id: row.id }));
        break;
      }

      case "generate": {
        const pattern = reqFlag(flags, "pattern");
        const name = (flags.name as string) ?? pattern;
        const grid = generateDem({
          pattern: pattern as never,
          nrows: flags.rows ? Number(flags.rows) : undefined,
          ncols: flags.cols ? Number(flags.cols) : undefined,
          cellSize: flags.cell ? Number(flags.cell) : undefined,
          seed: flags.seed ? Number(flags.seed) : 12345,
        });
        const row = repo.insertTerrain(name, grid);
        console.log(`generated terrain id=${row.id} pattern=${pattern}`);
        if (flags.out) writeFileSync(String(flags.out), JSON.stringify({
          nrows: grid.nrows, ncols: grid.ncols, cellSize: grid.cellSize, rows: gridToRows(grid),
        }, null, 2));
        if (!flags.out) printMatrix("elevation", gridToRows(grid) as unknown as unknown[][]);
        break;
      }

      case "inspect": {
        const tid = Number(positional[0] ?? reqFlag(flags, "terrain"));
        const result = service.inspectTerrain(tid);
        console.log(`terrain ${tid} stats`, JSON.stringify(result.stats, null, 2));
        console.log(`pits (raw depressions): ${result.pits.length}`);
        for (const p of result.pits) {
          console.log(`  id=${p.id} (r${p.row},c${p.col}) elev=${p.precision ?? p.elev}`);
        }
        if (json) console.log(JSON.stringify(result));
        break;
      }

      case "pour": {
        const tid = Number(reqFlag(flags, "terrain"));
        const r = Number(reqFlag(flags, "row"));
        const c = Number(reqFlag(flags, "col"));
        const id = repo.addPourPoint(tid, r, c, (flags.label as string) ?? null);
        console.log(`pour point id=${id} terrain=${tid} (r${r},c${c})`);
        break;
      }

      case "analyze":
      case "preprocess": {
        const tid = Number(reqFlag(flags, "terrain"));
        const fillStrategy = ((flags.fill as string) ?? "FILL").toUpperCase();
        const thresholdCount = Number(flags.threshold ?? "5");
        const pours = flags.pours ? String(flags.pours).split(",").map(Number) : [];
        const before = repo.listAnalyses(tid, 1, 0).total;
        console.log(`BEFORE: terrain ${tid} has ${before} analysis(es); fill=${fillStrategy} threshold=${thresholdCount} pours=[${pours.join(",")}]`);
        const result = repo.createAnalysis({
          terrainId: tid,
          fillStrategy: fillStrategy as "FILL" | "NONE",
          thresholdCount,
          pourPointIds: pours,
          idempotencyKey: flags.key ? String(flags.key) : undefined,
        });
        console.log(`AFTER:  analysis id=${result.row.id} ${result.reused ? "(reused identical params)" : "(created)"}`);
        console.log(JSON.stringify(result.computation.summary, null, 2));
        break;
      }

      case "trace": {
        const aid = Number(reqFlag(flags, "analysis"));
        const start = Number(reqFlag(flags, "cell"));
        const result = service.tracePath(aid, start);
        console.log(`downstream path from cell ${start}: ${result.length} cell(s)`);
        console.log(result.path.map((p) => `${p.id}[${p.status}]`).join(" -> "));
        break;
      }

      case "watershed":
      case "report": {
        const aid = Number(positional[0] ?? reqFlag(flags, "analysis"));
        const report = service.getReport(aid);
        console.log(JSON.stringify(report, null, 2));
        if (flags.out) writeFileSync(String(flags.out), JSON.stringify(report, null, 2));
        break;
      }

      case "matrix": {
        const aid = Number(reqFlag(flags, "analysis"));
        const layer = (flags.layer as string) ?? "count";
        const result = service.exportMatrix(aid, layer as never);
        if (flags.out) {
          writeFileSync(String(flags.out), JSON.stringify(result, null, 2));
          console.log(`wrote ${layer} matrix for analysis ${aid} -> ${flags.out}`);
        } else {
          printMatrix(`${layer} (analysis ${aid})`, result.matrix);
        }
        break;
      }

      case "compare-thresholds": {
        const tid = Number(reqFlag(flags, "terrain"));
        const values = String(reqFlag(flags, "values"))
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((v) => Number.isInteger(v) && v > 0);
        const fillStrategy = ((flags.fill as string) ?? "FILL").toUpperCase();
        const rows = values.map((thresholdCount) => {
          const r = repo.createAnalysis({
            terrainId: tid,
            fillStrategy: fillStrategy as "FILL" | "NONE",
            thresholdCount,
            pourPointIds: flags.pours ? String(flags.pours).split(",").map(Number) : [],
          });
          return {
            thresholdCount,
            analysisId: r.row.id,
            reused: r.reused,
            streamCells: r.computation.summary.streamCells,
            closedCells: r.computation.summary.closedCells,
            raisedCells: r.computation.summary.raisedCells,
          };
        });
        console.table(rows);
        if (json) console.log(JSON.stringify(rows));
        break;
      }

      case "list": {
        const kind = positional[0] ?? "terrains";
        const limit = Number(flags.limit ?? 50);
        const page = Number(flags.page ?? 1);
        if (kind === "terrains") console.log(JSON.stringify(repo.listTerrains(limit, (page - 1) * limit), null, 2));
        else if (kind === "analyses") console.log(JSON.stringify(repo.listAnalyses(flags.terrain ? Number(flags.terrain) : null, limit, (page - 1) * limit), null, 2));
        else throw new Error(`unknown list kind ${kind}`);
        break;
      }

      default:
        console.log(`unknown command: ${cmd}\n${USAGE}`);
        process.exitCode = 2;
    }
  } catch (err) {
    const e = err as Error & { code?: string };
    console.error(`ERROR [${e.code ?? "CLI_ERROR"}] ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

const USAGE = `grid-hydro CLI
  import --file=elev.json [--name=X] [--db=path]
  generate --pattern=slope|double-valley|closed-depression|flat|nodata-hole [--rows --cols --cell --seed --out]
  inspect <terrainId>
  pour --terrain=T --row=R --col=C [--label=L]
  analyze --terrain=T [--fill=FILL|NONE] [--threshold=N] [--pours=id,id] [--key=K]
  trace --analysis=A --cell=ID
  watershed <analysisId> [--out=report.json]
  matrix --analysis=A --layer=dir|downstream|count|area|stream|labels|processedElev|raiseAmount|status [--out=m.json]
  compare-thresholds --terrain=T --values=2,5,10 [--fill=FILL]
  list terrains|analyses [--page --limit --terrain]
`;

main();
