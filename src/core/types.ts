/**
 * Core domain types for raster hydrology analysis.
 *
 * Coordinate convention:
 *   row r increases downward (north -> south), col c increases rightward (west -> east).
 *   Linear index  id = r * ncols + c.
 */

/** D8 direction codes: 1=E 2=SE 3=S 4=SW 5=W 6=NW 7=N 8=NE ; 0 = no downslope flow. */
export type DirCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Processing status stored for every valid cell.
 *  UNCHANGED  original elevation used as-is, sloped routing
 *  RAISED     elevation raised during filling; carries a raise amount + drainage evidence
 *  FLAT_ROUTED cell on a flat surface, direction resolved deterministically
 *  CLOSED     part of a valid region with no external drainage path (no fill strategy solved it)
 *  PIT        under fillStrategy NONE: local depression receiving flow but unable to drain
 */
export type CellStatus = "UNCHANGED" | "RAISED" | "FLAT_ROUTED" | "CLOSED" | "PIT";

export type FillStrategy = "FILL" | "NONE";

export interface CellSourceInfo {
  /** Filled/preprocessed elevation used for routing. */
  processedElev: number;
  /** Original raw elevation (never overwritten). */
  rawElev: number;
  /** processedElev - rawElev, >= 0. Zero for unchanged cells. */
  raiseAmount: number;
  status: CellStatus;
  /**
   * Drainage evidence for a raised/flat cell: the id of the neighbor cell that
   * provides the spill / outflow path (the lower neighbor governing the raise,
   * or the flat-gradient leading cell). Null when not applicable.
   */
  drainsToEvidence: number | null;
}

export interface DirectionResult {
  /** D8 code per cell; 0 for CLOSED/PIT/NoData cells. */
  dir: Uint8Array;
  /** Downstream linear index per cell; -1 for CLOSED/PIT/NoData cells. */
  downstream: Int32Array;
  source: CellSourceInfo[];
  /** Ids of cells that belong to valid regions with no external drainage path. */
  closedCellIds: number[];
  /** Ids of local pits left under fillStrategy NONE. */
  pitCellIds: number[];
  /** Ids whose elevation was raised. */
  raisedCellIds: number[];
}

export interface AccumulationResult {
  /** Number of upstream valid cells draining through each cell (includes itself). */
  count: Float64Array;
  /** Actual contributing area in squared grid-spacing units. */
  area: Float64Array;
}

export interface AnalysisOptions {
  fillStrategy: FillStrategy;
  /** Convergence threshold in *cell count* for stream extraction. */
  thresholdCount: number;
  /** Raster ids designated as pour points (must be valid cells). */
  pourPointIds: number[];
  /** Client-supplied idempotency key; same key + same params returns same analysis. */
  idempotencyKey?: string;
}

export interface GridMeta {
  nrows: number;
  ncols: number;
  /** Grid spacing in metres (square cells). */
  cellSize: number;
}

export interface ElevationGrid extends GridMeta {
  /** Raw elevations; NaN denotes NoData. Never mutated by analysis code. */
  elev: Float64Array;
}

export interface PourPoint {
  id: number;
  terrainId: number;
  row: number;
  col: number;
  label: string | null;
}
