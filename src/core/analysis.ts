import { computeAccumulation, extractStream } from "./accumulation.js";
import { computeFlowDirections } from "./flowdir.js";
import { buildGrid } from "./grid.js";
import { gridStats } from "./inspect.js";
import type { ElevationGrid } from "./types.js";
import { delineateWatersheds } from "./watershed.js";
import type { AnalysisOptions } from "./types.js";

export interface AnalysisComputation {
  grid: ElevationGrid;
  options: AnalysisOptions;
  dir: Uint8Array;
  downstream: Int32Array;
  count: Float64Array;
  area: Float64Array;
  stream: Uint8Array;
  labels: Int32Array;
  statuses: string[];
  processedElev: Float64Array;
  raiseAmount: Float64Array;
  drainsToEvidence: Int32Array;
  summary: AnalysisSummary;
}

export interface AnalysisSummary {
  totalCells: number;
  validCells: number;
  nodataCells: number;
  raisedCells: number;
  flatRoutedCells: number;
  closedCells: number;
  pitCells: number;
  closedArea: number;
  streamCells: number;
  pourPointCount: number;
  watersheds: { label: number; pourPointId: number; cellCount: number; area: number }[];
}

export function runAnalysis(
  raw: { nrows: number; ncols: number; cellSize: number; elev: Float64Array },
  options: AnalysisOptions,
): AnalysisComputation {
  const grid = buildGrid(raw.nrows, raw.ncols, raw.cellSize, elevToRows(raw));
  for (const pp of options.pourPointIds) {
    if (!Number.isInteger(pp) || pp < 0 || pp >= grid.elev.length) {
      const e = new Error(`pour point ${pp} is out of range`) as Error & { code: string };
      e.code = "VALIDATION_ERROR";
      throw e;
    }
    if (Number.isNaN(grid.elev[pp] as number)) {
      const e = new Error(`pour point ${pp} is on a NoData cell`) as Error & { code: string };
      e.code = "VALIDATION_ERROR";
      throw e;
    }
  }
  if (!Number.isFinite(options.thresholdCount) || options.thresholdCount < 1) {
    const e = new Error("thresholdCount must be >= 1") as Error & { code: string };
    e.code = "VALIDATION_ERROR";
    throw e;
  }

  const d = computeFlowDirections(grid, options.fillStrategy, options.pourPointIds);
  const acc = computeAccumulation(grid, d);
  const stream = extractStream(acc, options.thresholdCount);
  const ws = delineateWatersheds(grid, d, options.pourPointIds);

  const n = grid.elev.length;
  const statuses = new Array<string>(n).fill("NODATA");
  const processedElev = new Float64Array(n);
  const raiseAmount = new Float64Array(n);
  const drainsToEvidence = new Int32Array(n).fill(-1);
  let raised = 0;
  let flatRouted = 0;
  for (let id = 0; id < n; id++) {
    const info = d.source[id];
    if (!info) continue;
    statuses[id] = info.status;
    processedElev[id] = info.processedElev;
    raiseAmount[id] = info.raiseAmount;
    drainsToEvidence[id] = info.drainsToEvidence ?? -1;
    if (info.status === "RAISED") raised++;
    if (info.status === "FLAT_ROUTED") flatRouted++;
  }

  const stats = gridStats(grid);
  let streamCells = 0;
  for (const v of stream) streamCells += v;
  const closedArea = d.closedCellIds.length * grid.cellSize * grid.cellSize;

  return {
    grid,
    options,
    dir: d.dir,
    downstream: d.downstream,
    count: acc.count,
    area: acc.area,
    stream,
    labels: ws.labels,
    statuses,
    processedElev,
    raiseAmount,
    drainsToEvidence,
    summary: {
      totalCells: n,
      validCells: stats.validCells,
      nodataCells: stats.nodataCells,
      raisedCells: raised,
      flatRoutedCells: flatRouted,
      closedCells: d.closedCellIds.length,
      pitCells: d.pitCellIds.length,
      closedArea,
      streamCells,
      pourPointCount: options.pourPointIds.length,
      watersheds: ws.pourPointIds.map((pp, i) => ({
        label: i + 1,
        pourPointId: pp,
        cellCount: ws.counts[i + 1] as number,
        area: ws.areas[i + 1] as number,
      })),
    },
  };
}

function elevToRows(raw: {
  nrows: number;
  ncols: number;
  elev: Float64Array;
}): (number | null)[][] {
  const rows: (number | null)[][] = [];
  for (let r = 0; r < raw.nrows; r++) {
    const row: (number | null)[] = [];
    for (let c = 0; c < raw.ncols; c++) {
      const v = raw.elev[r * raw.ncols + c] as number;
      row.push(Number.isNaN(v) ? null : v);
    }
    rows.push(row);
  }
  return rows;
}
