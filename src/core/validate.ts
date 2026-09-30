import type { FillStrategy } from "./types.ts";

export class ValidationError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.details = details;
  }
}

export function assertInteger(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v))
    throw new ValidationError("INVALID_INTEGER", `${field} must be an integer`, {
      field,
      value: v,
    });
  return v;
}

export function validateTerrainInput(body: any): {
  name: string;
  rows: number;
  cols: number;
  cellSize: number;
  noDataValue: number | null;
  matrix: number[][];
} {
  if (!body || typeof body !== "object")
    throw new ValidationError("INVALID_BODY", "request body must be an object");
  const name = body.name;
  if (typeof name !== "string" || name.trim() === "")
    throw new ValidationError("INVALID_NAME", "name is required");
  const cellSize = body.cellSize;
  if (typeof cellSize !== "number" || cellSize <= 0)
    throw new ValidationError(
      "INVALID_CELL_SIZE",
      "cellSize must be a positive number",
    );
  const matrix = body.matrix;
  if (!Array.isArray(matrix) || matrix.length === 0)
    throw new ValidationError("INVALID_MATRIX", "matrix must be a non-empty 2D array");
  const rows = matrix.length;
  const cols = matrix[0].length;
  if (!Number.isInteger(cols) || cols <= 0)
    throw new ValidationError("INVALID_MATRIX", "first row is empty");
  const nd =
    body.noDataValue === undefined || body.noDataValue === null
      ? null
      : body.noDataValue;
  if (nd !== null && typeof nd !== "number")
    throw new ValidationError("INVALID_NODATA", "noDataValue must be a number");
  for (let r = 0; r < rows; r++) {
    if (!Array.isArray(matrix[r]) || matrix[r].length !== cols)
      throw new ValidationError(
        "RASTER_NOT_REGULAR",
        `row ${r} must have exactly ${cols} cells`,
      );
    for (let c = 0; c < cols; c++) {
      const v = matrix[r][c];
      if (v === null) continue;
      if (typeof v !== "number" || Number.isNaN(v))
        throw new ValidationError(
          "INVALID_ELEVATION",
          `matrix[${r}][${c}] must be a number or null`,
        );
    }
  }
  return { name, rows, cols, cellSize, noDataValue: nd, matrix };
}

export function validateAnalysisInput(body: any): {
  fillStrategy: FillStrategy;
  threshold: number;
  outlets: Array<{ row: number; col: number }>;
  requestKey?: string;
} {
  if (!body || typeof body !== "object")
    throw new ValidationError("INVALID_BODY", "request body must be an object");
  const strategy = body.fillStrategy ?? "fill";
  if (!["none", "fill", "breach"].includes(strategy))
    throw new ValidationError(
      "INVALID_STRATEGY",
      "fillStrategy must be one of none|fill|breach",
    );
  const threshold = body.threshold ?? 1;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 1
  )
    throw new ValidationError(
      "INVALID_THRESHOLD",
      "threshold must be a number >= 1 (cells)",
    );
  const outlets = body.outlets ?? [];
  if (!Array.isArray(outlets))
    throw new ValidationError("INVALID_OUTLETS", "outlets must be an array");
  for (let i = 0; i < outlets.length; i++) {
    const o = outlets[i];
    if (
      !o ||
      !Number.isInteger(o.row) ||
      !Number.isInteger(o.col) ||
      o.row < 0 ||
      o.col < 0
    )
      throw new ValidationError(
        "INVALID_OUTLET",
        `outlets[${i}] needs non-negative integer row and col`,
      );
  }
  const requestKey =
    body.requestKey === undefined ? undefined : String(body.requestKey);
  return { fillStrategy: strategy, threshold, outlets, requestKey };
}

export function validatePagination(query: URLSearchParams): {
  limit: number;
  offset: number;
} {
  const limitRaw = Number(query.get("limit") ?? "50");
  const offsetRaw = Number(query.get("offset") ?? "0");
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 500)
    throw new ValidationError("INVALID_LIMIT", "limit must be 1..500");
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0)
    throw new ValidationError("INVALID_OFFSET", "offset must be >= 0");
  return { limit: limitRaw, offset: offsetRaw };
}
