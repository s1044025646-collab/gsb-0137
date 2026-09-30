import { withTransaction, type DB } from "./database.ts";
import { gridFromMatrix } from "../core/grid.ts";
import { preprocess } from "../core/depressions.ts";
import {
  computeFlow,
  delineateWatershed,
  extractStream,
  traceDownstream,
} from "../core/flow.ts";
import type {
  AnalysisConfig,
  ElevationGrid,
  FillStrategy,
  FlowResult,
  PreprocessResult,
} from "../core/types.ts";

export interface TerrainRecord {
  id: number;
  name: string;
  rows: number;
  cols: number;
  cellSize: number;
  noDataValue: number | null;
  validCells: number;
  createdAt: string;
}

export interface AnalysisSummary {
  id: number;
  terrainId: number;
  fillStrategy: FillStrategy;
  threshold: number;
  outletCells: number[];
  status: string;
  createdAt: string;
  filledCellCount: number;
  closedDepressionCount: number;
  closedCells: number;
  streamCellCount: number;
}

export interface FullAnalysis {
  summary: AnalysisSummary;
  pre: PreprocessResult;
  flow: FlowResult;
  watersheds: Array<{
    outletCell: number;
    cellCount: number;
    area: number;
    members: number[];
  }>;
  streamCells: number[];
  report: Record<string, unknown>;
}

function parseMatrix(text: string): number[][] {
  return JSON.parse(text) as number[][];
}

export function loadTerrainGrid(db: DB, terrainId: number): ElevationGrid {
  const row = db
    .prepare("SELECT * FROM terrains WHERE id = ?")
    .get(terrainId) as
    | {
        rows: number;
        cols: number;
        cell_size: number;
        no_data_value: number | null;
        raw_matrix: string;
      }
    | undefined;
  if (!row) throw new NotFoundError(`terrain ${terrainId} not found`);
  const matrix = parseMatrix(row.raw_matrix);
  return gridFromMatrix(matrix, row.cell_size, row.no_data_value);
}

export function saveTerrain(
  db: DB,
  name: string,
  grid: ElevationGrid,
  now: () => string,
): TerrainRecord {
  const matrix: number[][] = [];
  for (let r = 0; r < grid.rows; r++) {
    const out: number[] = [];
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      out.push(grid.mask[i] ? NaN : grid.elev[i]);
    }
    matrix.push(out);
  }
  const valid = grid.mask.reduce((a, b) => a + (b ? 0 : 1), 0);
  const id = withTransaction(db, () => {
    const res = db
      .prepare(
        `INSERT INTO terrains
          (name, rows, cols, cell_size, no_data_value, valid_cells, created_at, raw_matrix)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        name,
        grid.rows,
        grid.cols,
        grid.cellSize,
        grid.noDataValue,
        valid,
        now(),
        JSON.stringify(matrix),
      );
    return Number(res.lastInsertRowid);
  });
  return {
    id,
    name,
    rows: grid.rows,
    cols: grid.cols,
    cellSize: grid.cellSize,
    noDataValue: grid.noDataValue,
    validCells: valid,
    createdAt: now(),
  };
}

export function listTerrains(db: DB, limit: number, offset: number) {
  const total = (
    db.prepare("SELECT COUNT(*) AS n FROM terrains").get() as { n: number }
  ).n;
  const items = db
    .prepare(
      "SELECT id, name, rows, cols, cell_size, no_data_value, valid_cells, created_at FROM terrains ORDER BY id LIMIT ? OFFSET ?",
    )
    .all(limit, offset) as unknown as TerrainRecord[];
  return { items, total, limit, offset };
}

export function getTerrain(db: DB, id: number): TerrainRecord {
  const row = db
    .prepare(
      "SELECT id, name, rows, cols, cell_size, no_data_value, valid_cells, created_at FROM terrains WHERE id = ?",
    )
    .get(id) as TerrainRecord | undefined;
  if (!row) throw new NotFoundError(`terrain ${id} not found`);
  return row;
}

/** Idempotently run (or fetch) an analysis for a terrain + configuration. */
export function runAnalysis(
  db: DB,
  terrainId: number,
  config: AnalysisConfig,
  now: () => string,
  requestKey?: string,
): FullAnalysis {
  const grid = loadTerrainGrid(db, terrainId);
  const outletCells = config.outlets.map((o) => o.row * grid.cols + o.col);
  const key = requestKey ?? null;

  const existing = db
    .prepare(
      `SELECT id FROM analyses
       WHERE terrain_id=? AND fill_strategy=? AND threshold=?
         AND outlet_cells=? AND (request_key IS ? OR request_key=?)`,
    )
    .get(
      terrainId,
      config.fillStrategy,
      config.threshold,
      JSON.stringify(outletCells.slice().sort((a, b) => a - b)),
      key,
      key,
    ) as { id: number } | undefined;
  if (existing) return loadAnalysis(db, existing.id);

  const pre = preprocess(grid, config.fillStrategy);
  const flow = computeFlow(pre);
  const watersheds = outletCells.map((cell) => {
    const r = Math.floor(cell / grid.cols);
    const c = cell % grid.cols;
    const w = delineateWatershed(flow, r, c);
    return {
      outletCell: cell,
      cellCount: w.cellCount,
      area: w.area,
      members: w.cells,
    };
  });
  const streamCells = extractStream(flow, config.threshold);

  const report = buildReport(
    grid,
    pre,
    flow,
    watersheds,
    streamCells,
    config,
  );

  const sortedOutlets = outletCells.slice().sort((a, b) => a - b);
  const analysisId = withTransaction(db, () => {
    const res = db
      .prepare(
        `INSERT INTO analyses
          (terrain_id, fill_strategy, threshold, outlet_cells, request_key, status, created_at)
         VALUES (?,?,?,?,?, 'complete', ?)`,
      )
      .run(
        terrainId,
        config.fillStrategy,
        config.threshold,
        JSON.stringify(sortedOutlets),
        key,
        now(),
      );
    const analysisId = Number(res.lastInsertRowid);

    const cellStmt = db.prepare(
      `INSERT INTO analysis_cells
        (analysis_id, cell_index, row_no, col_no, raw_z, eff_z, delta,
         source_state, dir_code, receiver, upstream_cells, accumulation_area)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < grid.rows * grid.cols; i++) {
      const r = Math.floor(i / grid.cols);
      const c = i % grid.cols;
      cellStmt.run(
        analysisId,
        i,
        r,
        c,
        grid.mask[i] ? null : grid.elev[i],
        grid.mask[i] ? null : pre.elev[i],
        grid.mask[i] ? 0 : pre.delta[i],
        grid.mask[i] ? 5 : pre.source[i],
        flow.dir[i],
        flow.receiver[i],
        grid.mask[i] ? 0 : flow.upstreamCellCount[i],
        grid.mask[i] ? 0 : flow.accumulationArea[i],
      );
    }

    const depStmt = db.prepare(
      `INSERT INTO depressions
        (analysis_id, pour_point, spill_cell, spill_elevation, cell_count,
         closed, raised_cells)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const d of pre.depressions) {
      depStmt.run(
        analysisId,
        d.pourPoint,
        d.spillCell,
        d.spillElevation,
        d.cellCount,
        d.closed ? 1 : 0,
        JSON.stringify(d.raisedCells),
      );
    }

    const wsStmt = db.prepare(
      `INSERT INTO watersheds
        (analysis_id, outlet_cell, cell_count, area, members)
       VALUES (?,?,?,?,?)`,
    );
    for (const w of watersheds) {
      wsStmt.run(
        analysisId,
        w.outletCell,
        w.cellCount,
        w.area,
        JSON.stringify(w.members),
      );
    }

    db.prepare(
      "INSERT INTO reports (analysis_id, payload, created_at) VALUES (?,?,?)",
    ).run(analysisId, JSON.stringify(report), now());

    return analysisId;
  });
  return loadAnalysis(db, analysisId);
}

function buildReport(
  grid: ElevationGrid,
  pre: PreprocessResult,
  flow: FlowResult,
  watersheds: FullAnalysis["watersheds"],
  streamCells: number[],
  config: AnalysisConfig,
): Record<string, unknown> {
  const totalCells = grid.rows * grid.cols;
  const valid = totalCells - grid.mask.reduce((a, b) => a + b, 0);
  const closedCells = pre.closedDepressionCells.length;
  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    terrain: {
      rows: grid.rows,
      cols: grid.cols,
      cellSize: grid.cellSize,
      totalCells,
      validCells: valid,
      noDataCells: totalCells - valid,
      cellArea: grid.cellSize * grid.cellSize,
      validArea: valid * grid.cellSize * grid.cellSize,
    },
    config: {
      fillStrategy: config.fillStrategy,
      thresholdCells: config.threshold,
      thresholdArea: config.threshold * grid.cellSize * grid.cellSize,
      outlets: config.outlets,
    },
    preprocessing: {
      strategy: pre.strategy,
      filledCellCount: pre.filledCellCount,
      fillVolume: pre.fillVolume,
      closedDepressionCount: pre.depressions.filter((d) => d.closed).length,
      closedCells,
      depressions: pre.depressions,
    },
    flow: {
      streamCellCount: streamCells.length,
      sinkCount: countSinks(flow),
      outsideOutletCount: countOutside(flow),
    },
    watersheds: watersheds.map((w) => ({
      outletCell: w.outletCell,
      cellCount: w.cellCount,
      area: w.area,
    })),
  };
}

function countSinks(flow: FlowResult): number {
  let n = 0;
  for (let i = 0; i < flow.receiver.length; i++)
    if (!flow.mask[i] && flow.receiver[i] === -1) n++;
  return n;
}

function countOutside(flow: FlowResult): number {
  let n = 0;
  for (let i = 0; i < flow.receiver.length; i++)
    if (!flow.mask[i] && flow.receiver[i] === -2) n++;
  return n;
}

export function loadAnalysis(db: DB, analysisId: number): FullAnalysis {
  const row = db
    .prepare("SELECT * FROM analyses WHERE id = ?")
    .get(analysisId) as
    | {
        id: number;
        terrain_id: number;
        fill_strategy: FillStrategy;
        threshold: number;
        outlet_cells: string;
        status: string;
        created_at: string;
      }
    | undefined;
  if (!row) throw new NotFoundError(`analysis ${analysisId} not found`);

  const cellRows = db
    .prepare("SELECT * FROM analysis_cells WHERE analysis_id = ? ORDER BY cell_index")
    .all(analysisId) as Array<{
      cell_index: number;
      row_no: number;
      col_no: number;
      raw_z: number | null;
      eff_z: number | null;
      delta: number;
      source_state: number;
      dir_code: number;
      receiver: number;
      upstream_cells: number;
      accumulation_area: number;
    }>;

  const n = cellRows.length;
  const pre: PreprocessResult = {
    rows: 0,
    cols: 0,
    cellSize: 0,
    elev: new Float64Array(n),
    mask: new Uint8Array(n),
    source: new Uint8Array(n),
    delta: new Float32Array(n),
    strategy: row.fill_strategy,
    closedDepressionCells: [],
    filledCellCount: 0,
    fillVolume: 0,
    depressions: [],
  };
  const flow: FlowResult = {
    rows: 0,
    cols: 0,
    cellSize: 0,
    dir: new Uint8Array(n),
    receiver: new Int32Array(n),
    upstreamCellCount: new Float64Array(n),
    accumulationArea: new Float64Array(n),
    mask: new Uint8Array(n),
  };
  for (const cr of cellRows) {
    const i = cr.cell_index;
    pre.elev[i] = cr.eff_z ?? NaN;
    pre.mask[i] = cr.raw_z === null ? 1 : 0;
    pre.source[i] = cr.source_state;
    pre.delta[i] = cr.delta;
    flow.dir[i] = cr.dir_code;
    flow.receiver[i] = cr.receiver;
    flow.upstreamCellCount[i] = cr.upstream_cells;
    flow.accumulationArea[i] = cr.accumulation_area;
    flow.mask[i] = pre.mask[i];
  }
  const meta = db
    .prepare("SELECT rows, cols, cell_size FROM terrains WHERE id = ?")
    .get(row.terrain_id) as { rows: number; cols: number; cell_size: number };
  pre.rows = flow.rows = meta.rows;
  pre.cols = flow.cols = meta.cols;
  pre.cellSize = flow.cellSize = meta.cell_size;

  const depRows = db
    .prepare("SELECT * FROM depressions WHERE analysis_id = ?")
    .all(analysisId) as Array<{
      pour_point: number;
      spill_cell: number | null;
      spill_elevation: number | null;
      cell_count: number;
      closed: number;
      raised_cells: string;
    }>;
  pre.depressions = depRows.map((d) => ({
    pourPoint: d.pour_point,
    spillCell: d.spill_cell,
    spillElevation: d.spill_elevation,
    cellCount: d.cell_count,
    closed: d.closed === 1,
    raisedCells: JSON.parse(d.raised_cells),
  }));
  pre.closedDepressionCells = pre.depressions
    .filter((d) => d.closed)
    .flatMap((d) => d.raisedCells);
  pre.filledCellCount = pre.source.filter((s) => s === 1).length;
  pre.fillVolume = pre.delta.reduce(
    (a, b) => a + (b > 0 ? b * meta.cell_size * meta.cell_size : 0),
    0,
  );

  const wsRows = db
    .prepare("SELECT * FROM watersheds WHERE analysis_id = ?")
    .all(analysisId) as Array<{
      outlet_cell: number;
      cell_count: number;
      area: number;
      members: string;
    }>;
  const watersheds = wsRows.map((w) => ({
    outletCell: w.outlet_cell,
    cellCount: w.cell_count,
    area: w.area,
    members: JSON.parse(w.members) as number[],
  }));

  const streamCells = extractStream(
    flow,
    row.threshold,
  );

  const reportRow = db
    .prepare("SELECT payload FROM reports WHERE analysis_id = ?")
    .get(analysisId) as { payload: string } | undefined;
  const report = reportRow
    ? (JSON.parse(reportRow.payload) as Record<string, unknown>)
    : {};

  const summary: AnalysisSummary = {
    id: row.id,
    terrainId: row.terrain_id,
    fillStrategy: row.fill_strategy,
    threshold: row.threshold,
    outletCells: JSON.parse(row.outlet_cells),
    status: row.status,
    createdAt: row.created_at,
    filledCellCount: pre.filledCellCount,
    closedDepressionCount: pre.depressions.filter((d) => d.closed).length,
    closedCells: pre.closedDepressionCells.length,
    streamCellCount: streamCells.length,
  };

  return { summary, pre, flow, watersheds, streamCells, report };
}

export function listAnalyses(db: DB, terrainId: number, limit: number, offset: number) {
  const total = (
    db
      .prepare("SELECT COUNT(*) AS n FROM analyses WHERE terrain_id = ?")
      .get(terrainId) as { n: number }
  ).n;
  const items = db
    .prepare(
      `SELECT id, terrain_id, fill_strategy, threshold, outlet_cells, status, created_at
       FROM analyses WHERE terrain_id = ? ORDER BY id LIMIT ? OFFSET ?`,
    )
    .all(terrainId, limit, offset) as Array<{
      id: number;
      terrain_id: number;
      fill_strategy: FillStrategy;
      threshold: number;
      outlet_cells: string;
      status: string;
      created_at: string;
    }>;
  return {
    items: items.map((r) => ({
      id: r.id,
      terrainId: r.terrain_id,
      fillStrategy: r.fill_strategy,
      threshold: r.threshold,
      outletCells: JSON.parse(r.outlet_cells),
      status: r.status,
      createdAt: r.created_at,
    })),
    total,
    limit,
    offset,
  };
}

export function getReport(db: DB, analysisId: number) {
  const row = db
    .prepare("SELECT payload FROM reports WHERE analysis_id = ?")
    .get(analysisId) as { payload: string } | undefined;
  if (!row) throw new NotFoundError(`report for analysis ${analysisId} not found`);
  return JSON.parse(row.payload) as Record<string, unknown>;
}

export function tracePath(
  db: DB,
  analysisId: number,
  row: number,
  col: number,
): Array<{ row: number; col: number; state: string }> {
  const { flow } = loadAnalysis(db, analysisId);
  return traceDownstream(flow, row, col);
}

export function deleteTerrain(db: DB, terrainId: number): void {
  withTransaction(db, () => {
    const ids = db
      .prepare("SELECT id FROM analyses WHERE terrain_id = ?")
      .all(terrainId) as Array<{ id: number }>;
    for (const a of ids) {
      db.prepare("DELETE FROM analysis_cells WHERE analysis_id = ?").run(a.id);
      db.prepare("DELETE FROM depressions WHERE analysis_id = ?").run(a.id);
      db.prepare("DELETE FROM watersheds WHERE analysis_id = ?").run(a.id);
      db.prepare("DELETE FROM reports WHERE analysis_id = ?").run(a.id);
    }
    db.prepare("DELETE FROM analyses WHERE terrain_id = ?").run(terrainId);
    db.prepare("DELETE FROM terrains WHERE id = ?").run(terrainId);
  });
}

export class NotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NotFoundError";
  }
}
