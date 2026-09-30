import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AnalysisComputation } from "../core/analysis.js";
import { runAnalysis } from "../core/analysis.js";
import type { ElevationGrid, FillStrategy } from "../core/types.js";
import {
  blobToF64,
  blobToI32,
  blobToMask,
  blobToStatusList,
  blobToU8,
  f64ToBlob,
  i32ToBlob,
  maskToBlob,
  statusListToBlob,
  u8ToBlob,
} from "./codec.js";
import { Clock, systemClock, withTransaction } from "./database.js";

export interface TerrainRow {
  id: number;
  name: string;
  nrows: number;
  ncols: number;
  cell_size: number;
  created_at: string;
}

export interface AnalysisRow {
  id: number;
  terrain_id: number;
  fill_strategy: FillStrategy;
  threshold_count: number;
  idempotency_key: string | null;
  created_at: string;
  params_hash: string;
  summary_json: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateAnalysisInput {
  terrainId: number;
  fillStrategy: FillStrategy;
  thresholdCount: number;
  pourPointIds: number[];
  idempotencyKey?: string;
}

export class Repository {
  constructor(
    private db: DatabaseSync,
    private clock: Clock = systemClock,
  ) {}

  insertTerrain(name: string, grid: ElevationGrid): TerrainRow {
    const now = this.clock.now().toISOString();
    const elevBlob = f64ToBlob(grid.elev);
    const maskBlob = maskToBlob(grid.elev.length, (id) =>
      Number.isNaN(grid.elev[id] as number),
    );
    const info = this.db
      .prepare(
        `INSERT INTO terrains (name, nrows, ncols, cell_size, elev, nodata_mask, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, grid.nrows, grid.ncols, grid.cellSize, elevBlob, maskBlob, now);
    return this.getTerrain(Number(info.lastInsertRowid)) as TerrainRow;
  }

  getTerrain(id: number): TerrainRow | null {
    return (this.db.prepare("SELECT * FROM terrains WHERE id = ?").get(id) as TerrainRow) ?? null;
  }

  loadTerrainGrid(id: number): (ElevationGrid & TerrainRow) | null {
    const row = this.db
      .prepare("SELECT * FROM terrains WHERE id = ?")
      .get(id) as (TerrainRow & { elev: Uint8Array }) | undefined;
    if (!row) return null;
    const elev = blobToF64(row.elev);
    const { elev: _e, ...meta } = row;
    return { ...meta, elev };
  }

  listTerrains(limit: number, offset: number): Page<TerrainRow> {
    const total = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM terrains").get() as { n: number }).n,
    );
    const items = this.db
      .prepare("SELECT id,name,nrows,ncols,cell_size,created_at FROM terrains ORDER BY id LIMIT ? OFFSET ?")
      .all(limit, offset) as TerrainRow[];
    return { items, total, limit, offset };
  }

  addPourPoint(terrainId: number, row: number, col: number, label: string | null): number {
    const t = this.requireTerrain(terrainId);
    if (row < 0 || row >= t.nrows || col < 0 || col >= t.ncols) {
      throw validationError(`pour point (${row},${col}) outside ${t.nrows}x${t.ncols}`);
    }
    const cellId = row * t.ncols + col;
    const grid = this.loadTerrainGrid(terrainId);
    if (grid && Number.isNaN(grid.elev[cellId] as number)) {
      throw validationError(`pour point (${row},${col}) is on a NoData cell`);
    }
    const existing = this.db
      .prepare("SELECT id FROM pour_points WHERE terrain_id = ? AND cell_id = ?")
      .get(terrainId, cellId) as { id: number } | undefined;
    if (existing) return existing.id;
    const info = this.db
      .prepare(
        `INSERT INTO pour_points (terrain_id, row_index, col_index, cell_id, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(terrainId, row, col, cellId, label, this.clock.now().toISOString());
    return Number(info.lastInsertRowid);
  }

  listPourPoints(terrainId: number, limit: number, offset: number): Page<{
    id: number;
    terrain_id: number;
    row_index: number;
    col_index: number;
    cell_id: number;
    label: string | null;
  }> {
    const total = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM pour_points WHERE terrain_id = ?")
          .get(terrainId) as { n: number }
      ).n,
    );
    const items = this.db
      .prepare(
        "SELECT id,terrain_id,row_index,col_index,cell_id,label FROM pour_points WHERE terrain_id = ? ORDER BY id LIMIT ? OFFSET ?",
      )
      .all(terrainId, limit, offset) as never;
    return { items, total, limit, offset };
  }

  /**
   * Create (or return an existing identical) analysis. Deterministic: the same
   * terrain + fill strategy + threshold + sorted pour points always maps to one
   * params hash, so repeat submissions are idempotent and isolated rows.
   */
  createAnalysis(input: CreateAnalysisInput): { row: AnalysisRow; computation: AnalysisComputation; reused: boolean } {
    const terrain = this.requireTerrain(input.terrainId);
    if (input.fillStrategy !== "FILL" && input.fillStrategy !== "NONE") {
      throw validationError("fillStrategy must be FILL or NONE");
    }
    if (!Number.isInteger(input.thresholdCount) || input.thresholdCount < 1) {
      throw validationError("thresholdCount must be a positive integer");
    }
    const pourCellIds = [...new Set(input.pourPointIds)].sort((a, b) => a - b);
    const grid = this.loadTerrainGrid(input.terrainId);
    if (!grid) throw validationError(`terrain ${input.terrainId} not found`);
    for (const cellId of pourCellIds) {
      if (cellId < 0 || cellId >= terrain.nrows * terrain.ncols) {
        throw validationError(`pour point cell ${cellId} out of range`);
      }
      if (Number.isNaN(grid.elev[cellId] as number)) {
        throw validationError(`pour point cell ${cellId} is NoData`);
      }
    }
    const paramsHash = hashParams({
      terrainId: input.terrainId,
      fillStrategy: input.fillStrategy,
      thresholdCount: input.thresholdCount,
      pourCellIds,
    });

    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare("SELECT * FROM analyses WHERE terrain_id = ? AND params_hash = ?")
        .get(input.terrainId, paramsHash) as AnalysisRow | undefined;
      const computation = runAnalysis(grid, {
        fillStrategy: input.fillStrategy,
        thresholdCount: input.thresholdCount,
        pourPointIds: pourCellIds,
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) {
        return { row: existing, computation, reused: true };
      }
      const now = this.clock.now().toISOString();
      const info = this.db
        .prepare(
          `INSERT INTO analyses (terrain_id, fill_strategy, threshold_count, idempotency_key, created_at, params_hash, summary_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.terrainId,
          input.fillStrategy,
          input.thresholdCount,
          input.idempotencyKey ?? null,
          now,
          paramsHash,
          JSON.stringify(computation.summary),
        );
      const analysisId = Number(info.lastInsertRowid);
      pourCellIds.forEach((cellId, ordinal) => {
        const pp = this.db
          .prepare("SELECT id FROM pour_points WHERE terrain_id = ? AND cell_id = ?")
          .get(input.terrainId, cellId) as { id: number } | undefined;
        if (pp) {
          this.db
            .prepare(
              "INSERT OR IGNORE INTO analysis_pourpoints (analysis_id, pour_point_id, ordinal) VALUES (?, ?, ?)",
            )
            .run(analysisId, pp.id, ordinal);
        }
      });
      this.db
        .prepare(
          `INSERT INTO analysis_layers (analysis_id, dir, downstream, count, area, stream, labels, status, processed_elev, raise_amount, drains_evidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          analysisId,
          u8ToBlob(computation.dir),
          i32ToBlob(computation.downstream),
          f64ToBlob(computation.count),
          f64ToBlob(computation.area),
          u8ToBlob(computation.stream),
          i32ToBlob(computation.labels),
          statusListToBlob(computation.statuses),
          f64ToBlob(computation.processedElev),
          f64ToBlob(computation.raiseAmount),
          i32ToBlob(computation.drainsToEvidence),
        );
      const row = this.db.prepare("SELECT * FROM analyses WHERE id = ?").get(analysisId) as AnalysisRow;
      return { row, computation, reused: false };
    });
  }

  getAnalysis(id: number): AnalysisRow | null {
    return (this.db.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as AnalysisRow) ?? null;
  }

  listAnalyses(terrainId: number | null, limit: number, offset: number): Page<AnalysisRow> {
    const where = terrainId === null ? "" : "WHERE terrain_id = ?";
    const args: unknown[] = terrainId === null ? [] : [terrainId];
    const total = Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM analyses ${where}`)
          .get(...args) as { n: number }
      ).n,
    );
    const items = this.db
      .prepare(
        `SELECT * FROM analyses ${where} ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as AnalysisRow[];
    return { items, total, limit, offset };
  }

  loadLayers(analysisId: number): LoadedLayers | null {
    const row = this.db.prepare("SELECT * FROM analysis_layers WHERE analysis_id = ?").get(analysisId) as
      | Record<string, Uint8Array>
      | undefined;
    if (!row) return null;
    return {
      dir: blobToU8(row.dir as Uint8Array),
      downstream: blobToI32(row.downstream as Uint8Array),
      count: blobToF64(row.count as Uint8Array),
      area: blobToF64(row.area as Uint8Array),
      stream: blobToU8(row.stream as Uint8Array),
      labels: blobToI32(row.labels as Uint8Array),
      statuses: blobToStatusList(row.status as Uint8Array),
      processedElev: blobToF64(row.processed_elev as Uint8Array),
      raiseAmount: blobToF64(row.raise_amount as Uint8Array),
      drainsEvidence: blobToI32(row.drains_evidence as Uint8Array),
    };
  }

  loadNodataMask(terrainId: number): Uint8Array | null {
    const row = this.db
      .prepare("SELECT nodata_mask, nrows, ncols FROM terrains WHERE id = ?")
      .get(terrainId) as { nodata_mask: Uint8Array; nrows: number; ncols: number } | undefined;
    if (!row) return null;
    return blobToMask(row.nodata_mask, row.nrows * row.ncols);
  }

  private requireTerrain(id: number): TerrainRow {
    const t = this.getTerrain(id);
    if (!t) throw notFound(`terrain ${id} not found`);
    return t;
  }
}

export interface LoadedLayers {
  dir: Uint8Array;
  downstream: Int32Array;
  count: Float64Array;
  area: Float64Array;
  stream: Uint8Array;
  labels: Int32Array;
  statuses: string[];
  processedElev: Float64Array;
  raiseAmount: Float64Array;
  drainsEvidence: Int32Array;
}

function hashParams(p: {
  terrainId: number;
  fillStrategy: string;
  thresholdCount: number;
  pourCellIds: number[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify(p))
    .digest("hex");
}

function validationError(message: string): Error & { code: string; status: number } {
  const e = new Error(message) as Error & { code: string; status: number };
  e.code = "VALIDATION_ERROR";
  e.status = 400;
  return e;
}
function notFound(message: string): Error & { code: string; status: number } {
  const e = new Error(message) as Error & { code: string; status: number };
  e.code = "NOT_FOUND";
  e.status = 404;
  return e;
}
