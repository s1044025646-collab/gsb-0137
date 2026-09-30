import type { FullAnalysis } from "../db/repository.ts";

export type MatrixKind =
  | "raw"
  | "filled"
  | "delta"
  | "source"
  | "direction"
  | "upstream"
  | "area"
  | "watershed";

export interface ExportedMatrix {
  kind: MatrixKind;
  rows: number;
  cols: number;
  /** 2D values; null marks NoData / non-member. */
  matrix: Array<Array<number | null>>;
}

function empty(rows: number, cols: number): Array<Array<number | null>> {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null),
  );
}

export function buildMatrix(
  full: FullAnalysis,
  rawGrid: { rows: number; cols: number },
  kind: MatrixKind,
  outletCell?: number,
): ExportedMatrix {
  const { rows, cols } = rawGrid;
  const m = empty(rows, cols);
  const { pre, flow } = full;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (pre.mask[i]) {
        m[r][c] = null;
        continue;
      }
      switch (kind) {
        case "raw":
          m[r][c] = round(pre.elev[i] - pre.delta[i]);
          break;
        case "filled":
          m[r][c] = round(pre.elev[i]);
          break;
        case "delta":
          m[r][c] = round(pre.delta[i]);
          break;
        case "source":
          m[r][c] = pre.source[i];
          break;
        case "direction":
          m[r][c] = flow.dir[i];
          break;
        case "upstream":
          m[r][c] = flow.upstreamCellCount[i];
          break;
        case "area":
          m[r][c] = round(flow.accumulationArea[i]);
          break;
      }
    }
  }
  if (kind === "watershed") {
    const ws = full.watersheds.find(
      (w) => outletCell === undefined || w.outletCell === outletCell,
    );
    if (!ws) {
      for (let i = 0; i < rows * cols; i++)
        m[Math.floor(i / cols)][i % cols] = null;
    } else {
      const memberSet = new Set(ws.members);
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          m[r][c] = !pre.mask[i] && memberSet.has(i) ? 1 : 0;
        }
    }
  }
  return { kind, rows, cols, matrix: m };
}

function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

export function toCSV(em: ExportedMatrix): string {
  return em.matrix
    .map((row) => row.map((v) => (v === null ? "" : String(v))).join(","))
    .join("\n");
}

export const MATRIX_KINDS: MatrixKind[] = [
  "raw",
  "filled",
  "delta",
  "source",
  "direction",
  "upstream",
  "area",
  "watershed",
];
