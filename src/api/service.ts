import { traceDownstreamPath } from "../core/flowdir.js";
import { generateDem, gridToRows, type DemPattern } from "../core/generator.js";
import { buildGrid } from "../core/grid.js";
import { findPits, gridStats } from "../core/inspect.js";
import { Repository } from "../db/repository.js";

export interface ApiError extends Error {
  code: string;
  status: number;
}

export function apiError(status: number, code: string, message: string): ApiError {
  const e = new Error(message) as ApiError;
  e.status = status;
  e.code = code;
  return e;
}

export class HydroService {
  constructor(public repo: Repository) {}

  importTerrain(body: { name?: unknown; nrows?: unknown; ncols?: unknown; cellSize?: unknown; rows?: unknown }) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw apiError(400, "VALIDATION_ERROR", "name is required");
    }
    const grid = buildGrid(body.nrows, body.ncols, body.cellSize, body.rows);
    const row = this.repo.insertTerrain(body.name.trim(), grid);
    return { terrain: row, stats: gridStats(grid) };
  }

  generateTerrain(body: {
    name?: unknown;
    pattern?: unknown;
    nrows?: unknown;
    ncols?: unknown;
    cellSize?: unknown;
    seed?: unknown;
  }) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw apiError(400, "VALIDATION_ERROR", "name is required");
    }
    const patterns: DemPattern[] = [
      "slope",
      "double-valley",
      "closed-depression",
      "flat",
      "nodata-hole",
    ];
    if (typeof body.pattern !== "string" || !patterns.includes(body.pattern as DemPattern)) {
      throw apiError(400, "VALIDATION_ERROR", `pattern must be one of ${patterns.join(", ")}`);
    }
    const numOrUndef = (v: unknown): number | undefined =>
      v === undefined ? undefined : Number(v);
    const grid = generateDem({
      pattern: body.pattern as DemPattern,
      nrows: numOrUndef(body.nrows),
      ncols: numOrUndef(body.ncols),
      cellSize: numOrUndef(body.cellSize),
      seed: numOrUndef(body.seed) ?? 12345,
    });
    const row = this.repo.insertTerrain(body.name.trim(), grid);
    return { terrain: row, stats: gridStats(grid), rows: gridToRows(grid) };
  }

  inspectTerrain(terrainId: number) {
    const grid = this.repo.loadTerrainGrid(terrainId);
    if (!grid) throw apiError(404, "NOT_FOUND", `terrain ${terrainId} not found`);
    return { terrainId, stats: gridStats(grid), pits: findPits(grid) };
  }

  addPourPoint(terrainId: number, body: { row?: unknown; col?: unknown; label?: unknown }) {
    const r = Number(body.row);
    const c = Number(body.col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) {
      throw apiError(400, "VALIDATION_ERROR", "row and col must be integers");
    }
    if (body.label !== null && body.label !== undefined && typeof body.label !== "string") {
      throw apiError(400, "VALIDATION_ERROR", "label must be a string or null");
    }
    const id = this.repo.addPourPoint(terrainId, r, c, (body.label as string | null) ?? null);
    return { pourPointId: id };
  }

  createAnalysis(terrainId: number, body: Record<string, unknown>) {
    const fillStrategy = body.fillStrategy;
    if (fillStrategy !== "FILL" && fillStrategy !== "NONE") {
      throw apiError(400, "VALIDATION_ERROR", "fillStrategy must be FILL or NONE");
    }
    const thresholdCount = Number(body.thresholdCount);
    if (!Number.isInteger(thresholdCount) || thresholdCount < 1) {
      throw apiError(400, "VALIDATION_ERROR", "thresholdCount must be a positive integer");
    }
    let pourCellIds: number[] = [];
    if (body.pourPoints !== undefined) {
      if (!Array.isArray(body.pourPoints)) {
        throw apiError(400, "VALIDATION_ERROR", "pourPoints must be an array of cell ids");
      }
      pourCellIds = body.pourPoints.map((v) => Number(v));
      if (pourCellIds.some((v) => !Number.isInteger(v) || v < 0)) {
        throw apiError(400, "VALIDATION_ERROR", "pourPoints must be non-negative integer cell ids");
      }
    }
    if (
      body.idempotencyKey !== undefined &&
      typeof body.idempotencyKey !== "string"
    ) {
      throw apiError(400, "VALIDATION_ERROR", "idempotencyKey must be a string");
    }
    const result = this.repo.createAnalysis({
      terrainId,
      fillStrategy,
      thresholdCount,
      pourPointIds: pourCellIds,
      idempotencyKey: body.idempotencyKey as string | undefined,
    });
    return {
      analysis: result.row,
      reused: result.reused,
      summary: result.computation.summary,
    };
  }

  getReport(analysisId: number) {
    const row = this.repo.getAnalysis(analysisId);
    if (!row) throw apiError(404, "NOT_FOUND", `analysis ${analysisId} not found`);
    return { analysis: row, summary: JSON.parse(row.summary_json) };
  }

  tracePath(analysisId: number, startId: number) {
    const analysis = this.repo.getAnalysis(analysisId);
    if (!analysis) throw apiError(404, "NOT_FOUND", `analysis ${analysisId} not found`);
    const grid = this.repo.loadTerrainGrid(analysis.terrain_id);
    const layers = this.repo.loadLayers(analysisId);
    if (!grid || !layers) throw apiError(404, "NOT_FOUND", "analysis layers missing");
    if (!Number.isInteger(startId) || startId < 0 || startId >= grid.elev.length) {
      throw apiError(400, "VALIDATION_ERROR", "startId out of range");
    }
    if (Number.isNaN(grid.elev[startId] as number)) {
      throw apiError(400, "VALIDATION_ERROR", "startId is a NoData cell");
    }
    const d = { dir: layers.dir, downstream: layers.downstream, source: [] };
    const pathIds = traceDownstreamPath(d as never, startId);
    return {
      path: pathIds.map((id) => ({
        id,
        row: Math.floor(id / grid.ncols),
        col: id % grid.ncols,
        status: layers.statuses[id],
        count: layers.count[id],
        area: layers.area[id],
      })),
      length: pathIds.length,
      terminatesAtBoundary: pathIds.length > 0,
    };
  }

  exportMatrix(
    analysisId: number,
    layer: "dir" | "downstream" | "count" | "area" | "stream" | "labels" | "processedElev" | "raiseAmount" | "status",
  ) {
    const analysis = this.repo.getAnalysis(analysisId);
    if (!analysis) throw apiError(404, "NOT_FOUND", `analysis ${analysisId} not found`);
    const grid = this.repo.loadTerrainGrid(analysis.terrain_id);
    const layers = this.repo.loadLayers(analysisId);
    if (!grid || !layers) throw apiError(404, "NOT_FOUND", "analysis layers missing");
    const allowed = [
      "dir",
      "downstream",
      "count",
      "area",
      "stream",
      "labels",
      "processedElev",
      "raiseAmount",
      "status",
    ] as const;
    if (!allowed.includes(layer)) {
      throw apiError(400, "VALIDATION_ERROR", `layer must be one of ${allowed.join(", ")}`);
    }
    const matrix: unknown[][] = [];
    for (let r = 0; r < grid.nrows; r++) {
      const rowOut: unknown[] = [];
      for (let c = 0; c < grid.ncols; c++) {
        const id = r * grid.ncols + c;
        if (Number.isNaN(grid.elev[id] as number)) {
          rowOut.push(null);
          continue;
        }
        switch (layer) {
          case "dir":
            rowOut.push(layers.dir[id]);
            break;
          case "downstream":
            rowOut.push(layers.downstream[id]);
            break;
          case "count":
            rowOut.push(layers.count[id]);
            break;
          case "area":
            rowOut.push(layers.area[id]);
            break;
          case "stream":
            rowOut.push(layers.stream[id]);
            break;
          case "labels":
            rowOut.push(layers.labels[id]);
            break;
          case "processedElev":
            rowOut.push(layers.processedElev[id]);
            break;
          case "raiseAmount":
            rowOut.push(layers.raiseAmount[id]);
            break;
          case "status":
            rowOut.push(layers.statuses[id]);
            break;
        }
      }
      matrix.push(rowOut);
    }
    return {
      analysisId,
      layer,
      nrows: grid.nrows,
      ncols: grid.ncols,
      cellSize: grid.cell_size,
      matrix,
    };
  }
}
