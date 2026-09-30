import { createServer, Server, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { openDatabase, closeDatabase } from "../db/database.ts";
import type { DB } from "../db/database.ts";
import {
  getReport,
  getTerrain,
  listAnalyses,
  listTerrains,
  loadAnalysis,
  runAnalysis,
  saveTerrain,
  tracePath,
  NotFoundError,
  loadTerrainGrid,
} from "../db/repository.ts";
import { gridFromMatrix } from "../core/grid.ts";
import {
  validateAnalysisInput,
  validatePagination,
  validateTerrainInput,
  ValidationError,
} from "../core/validate.ts";
import { buildMatrix, MATRIX_KINDS, toCSV } from "../core/exporters.ts";

const DEFAULT_DB = resolve("data/app.sqlite");

export interface AppContext {
  db: DB;
  now: () => string;
}

export function startServer(
  opts: { dbPath?: string; port?: number; now?: () => string } = {},
): Promise<{ server: Server; port: number; close: () => void }> {
  const dbPath = opts.dbPath ?? process.env.TWSH_DB ?? DEFAULT_DB;
  const now = opts.now ?? (() => new Date().toISOString());
  const db = openDatabase(dbPath, now);
  const server = createServer((req, res) =>
    handle({ db, now }, req, res).catch((err) => sendError(res, err)),
  );
  return new Promise((p) => {
    // Bind loopback only; port 0 => OS assigns an ephemeral local port.
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      p({
        server,
        port,
        close: () => {
          server.close();
          closeDatabase(db);
        },
      });
    });
  });
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("INVALID_JSON", "request body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ValidationError) {
    send(res, 400, {
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  if (err instanceof NotFoundError) {
    send(res, 404, { error: { code: "NOT_FOUND", message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  send(res, 500, { error: { code: "INTERNAL", message } });
}

async function handle(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    send(res, 200, { status: "ok" });
    return;
  }

  // POST /terrains
  if (method === "POST" && path === "/terrains") {
    const body = await readJson(req);
    const t = validateTerrainInput(body);
    const grid = gridFromMatrix(t.matrix, t.cellSize, t.noDataValue);
    const rec = saveTerrain(ctx.db, t.name, grid, ctx.now);
    send(res, 201, rec);
    return;
  }
  if (method === "GET" && path === "/terrains") {
    const { limit, offset } = validatePagination(url.searchParams);
    send(res, 200, paginate(listTerrains(ctx.db, limit, offset)));
    return;
  }

  const terrainMatch = path.match(/^\/terrains\/(\d+)$/);
  if (terrainMatch) {
    const id = Number(terrainMatch[1]);
    if (method === "GET") {
      send(res, 200, getTerrain(ctx.db, id));
      return;
    }
  }

  // POST /terrains/:id/analyses
  const createAnalysis = path.match(
    /^\/terrains\/(\d+)\/analyses$/,
  );
  if (createAnalysis && method === "POST") {
    const terrainId = Number(createAnalysis[1]);
    getTerrain(ctx.db, terrainId); // 404 if missing
    const body = await readJson(req);
    const cfg = validateAnalysisInput(body);
    const grid = loadTerrainGrid(ctx.db, terrainId);
    for (const o of cfg.outlets) {
      if (o.row >= grid.rows || o.col >= grid.cols)
        throw new ValidationError(
          "OUTLET_OUT_OF_BOUNDS",
          `outlet (${o.row},${o.col}) outside ${grid.rows}x${grid.cols}`,
        );
      if (grid.mask[o.row * grid.cols + o.col])
        throw new ValidationError(
          "OUTLET_NODATA",
          `outlet (${o.row},${o.col}) is a NoData cell`,
        );
    }
    const full = runAnalysis(
      ctx.db,
      terrainId,
      {
        fillStrategy: cfg.fillStrategy,
        threshold: cfg.threshold,
        outlets: cfg.outlets,
      },
      ctx.now,
      cfg.requestKey,
    );
    send(res, 201, full.summary);
    return;
  }

  const listAnalysis = path.match(/^\/terrains\/(\d+)\/analyses$/);
  if (listAnalysis && method === "GET") {
    const terrainId = Number(listAnalysis[1]);
    getTerrain(ctx.db, terrainId);
    const { limit, offset } = validatePagination(url.searchParams);
    send(res, 200, paginate(listAnalyses(ctx.db, terrainId, limit, offset)));
    return;
  }

  const analysisMatch = path.match(/^\/analyses\/(\d+)$/);
  if (analysisMatch && method === "GET") {
    const full = loadAnalysis(ctx.db, Number(analysisMatch[1]));
    send(res, 200, full.summary);
    return;
  }

  const reportMatch = path.match(/^\/analyses\/(\d+)\/report$/);
  if (reportMatch && method === "GET") {
    send(res, 200, getReport(ctx.db, Number(reportMatch[1])));
    return;
  }

  const traceMatch = path.match(
    /^\/analyses\/(\d+)\/trace\/(\d+)\/(\d+)$/,
  );
  if (traceMatch && method === "GET") {
    const [, aid, r, c] = traceMatch;
    const result = tracePath(ctx.db, Number(aid), Number(r), Number(c));
    send(res, 200, { path: result });
    return;
  }

  const matrixMatch = path.match(/^\/analyses\/(\d+)\/matrix\/([a-z]+)$/);
  if (matrixMatch && method === "GET") {
    const aid = Number(matrixMatch[1]);
    const kind = matrixMatch[2] as (typeof MATRIX_KINDS)[number];
    if (!MATRIX_KINDS.includes(kind))
      throw new ValidationError(
        "INVALID_MATRIX_KIND",
        `kind must be one of ${MATRIX_KINDS.join("|")}`,
      );
    const full = loadAnalysis(ctx.db, aid);
    const terrain = getTerrain(ctx.db, full.summary.terrainId);
    const outletRaw = url.searchParams.get("outlet");
    const outletCell = outletRaw === null ? undefined : Number(outletRaw);
    const em = buildMatrix(
      full,
      { rows: terrain.rows, cols: terrain.cols },
      kind,
      outletCell,
    );
    if (url.searchParams.get("format") === "csv") {
      const csv = toCSV(em);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${kind}.csv"`,
      });
      res.end(csv);
      return;
    }
    send(res, 200, em);
    return;
  }

  send(res, 404, { error: { code: "ROUTE_NOT_FOUND", message: path } });
}

function paginate(r: {
  items: unknown[];
  total: number;
  limit: number;
  offset: number;
}) {
  return {
    items: r.items,
    total: r.total,
    limit: r.limit,
    offset: r.offset,
    hasMore: r.offset + r.items.length < r.total,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(({ port, close }) => {
    console.log(`[twsh] API listening on http://127.0.0.1:${port}`);
    console.log(`[twsh] database: ${process.env.TWSH_DB ?? DEFAULT_DB}`);
    const shutdown = () => {
      close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
