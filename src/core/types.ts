/**
 * Core domain types for raster terrain flow / watershed analysis.
 *
 * Conventions
 *  - Raster matrices are stored row-major flat Float64 arrays of length
    rows*cols. Index = r*cols + c.
 *  - NoData cells are encoded via a parallel Uint8 mask (`true` means the
    cell is MISSING / invalid). Elevation values in missing cells are
    never read as low elevation.
 *  - Directions use D8 codes (ESRI convention):
       1=E, 2=SE, 4=S, 8=SW, 16=W, 32=NW, 64=N, 128=NE
    0 = internal sink (no valid out-neighbour), 255 = outside-grid outlet
 *    (water leaves the modelled domain at a boundary).
 */

export const DIR_E = 1;
export const DIR_SE = 2;
export const DIR_S = 4;
export const DIR_SW = 8;
export const DIR_W = 16;
export const DIR_NW = 32;
export const DIR_N = 64;
export const DIR_NE = 128;
export const DIR_SINK = 0;
export const DIR_OUT = 255;

/** (dr, dc, euclidean distance multiplier) in code order 1,2,4,...,128 */
export const D8_NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 1], // 1  E
  [1, 1, Math.SQRT2], // 2  SE
  [1, 0, 1], // 4  S
  [1, -1, Math.SQRT2], // 8  SW
  [0, -1, 1], // 16 W
  [-1, -1, Math.SQRT2], // 32 NW
  [-1, 0, 1], // 64 N
  [-1, 1, Math.SQRT2], // 128 NE
];

export const DIR_CODE = Uint8Array.from([1, 2, 4, 8, 16, 32, 64, 128]);

export interface GridDims {
  rows: number;
  cols: number;
  /** Regular grid spacing in metres (equal in x and y). */
  cellSize: number;
}

export interface ElevationGrid extends GridDims {
  /** Raw elevations, length rows*cols. Missing values hold NaN. */
  elev: Float64Array;
  /** true => cell is NoData / missing (barrier, never an outlet). */
  mask: Uint8Array;
  /** Value used as NoData marker in the source file, if any. */
  noDataValue: number | null;
}

/** Depression handling strategy chosen for a preprocessing run. */
export type FillStrategy = "none" | "fill" | "breach";

/**
 * Result of depression handling. Elevations are only ever raised (fill) or
 * lowered along a carved spill path (breach); the raw grid is untouched.
 */
export interface PreprocessResult extends GridDims {
  /** Effective elevation used by flow routing (filled / breached). */
  elev: Float64Array;
  mask: Uint8Array;
  /** Per-cell source/status flag, see SOURCE_* below. */
  source: Uint8Array;
  /** Signed vertical change: effective - raw, for valid cells. */
  delta: Float32Array;
  strategy: FillStrategy;
  /** Valid cells that form closed depressions with no external spill path. */
  closedDepressionCells: number[];
  /** Number of cells raised while filling. */
  filledCellCount: number;
  /** Total raised volume proxy: sum(delta) * cellArea (m^3). */
  fillVolume: number;
  /** Human/machine readable notes about how each depression drains. */
  depressions: DepressionRecord[];
}

/** Per-cell provenance/status codes stored in PreprocessResult.source. */
export const SOURCE_UNTOUCHED = 0;
export const SOURCE_FILLED = 1; // raised to spill level, drains externally
export const SOURCE_BREACHED = 2; // lowered along a carved channel
export const SOURCE_FLAT_RESOLVED = 3; // raw-flat area, deterministic flow
export const SOURCE_CLOSED = 4; // valid cell in an unresolvable closed basin
export const SOURCE_NODATA = 5;

export interface DepressionRecord {
  /** Representative lowest cell of the depression. */
  pourPoint: number;
  /** Spill cell through which water escapes, or null when fully closed. */
  spillCell: number | null;
  /** Minimum elevation at which overflow occurs. */
  spillElevation: number | null;
  cellCount: number;
  /** True when the depression has no route to a boundary outlet. */
  closed: boolean;
  /** Cells raised to reach spillElevation (indices), capped in report. */
  raisedCells: number[];
}

export interface FlowResult extends GridDims {
  /** D8 direction code per valid cell. */
  dir: Uint8Array;
  /** Neighbour linear index the cell flows to; -1 for sink, -2 for outside. */
  receiver: Int32Array;
  /** Number of upstream valid cells including the cell itself. */
  upstreamCellCount: Float64Array;
  /** Upstream contributing area in square metres (cellCount * cellSize^2). */
  accumulationArea: Float64Array;
  mask: Uint8Array;
}

export interface OutletSpec {
  row: number;
  col: number;
}

export interface WatershedResult {
  outletIndex: number;
  /** All cells whose flow eventually reaches the outlet. */
  cells: number[];
  cellCount: number;
  area: number;
  /** Cells that flow to a boundary outside point but never reach outlet. */
  unreached: number[];
}

export interface AnalysisConfig {
  fillStrategy: FillStrategy;
  threshold: number;
  outlets: OutletSpec[];
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}
