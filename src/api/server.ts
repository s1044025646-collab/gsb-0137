import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db/database.js";
import { Repository } from "../db/repository.js";
import { HydroService, apiError } from "./service.js";

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;

export async function startApi(options: {
  dbPath: string;
  host?: string;
  port?: number; // 0 = auto-assign
  runDir?: string;
}): Promise<StartedServer> {
  const db = openDatabase(options.dbPath);
  const service = new HydroService(new Repository(db));
  const server = createServer((req, res) => handle(req, res, service));
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  if (options.runDir) {
    mkdirSync(options.runDir, { recursive: true });
    writeFileSync(join(options.runDir, "server.json"), JSON.stringify({ port, host, pid: process.pid }, null, 2));
  }
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        db.close();
        resolve();
      });
    });
  return { server, port, close };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY) throw apiError(413, "PAYLOAD_TOO_LARGE", "request body too large");
    chunks.push(b);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw apiError(400, "INVALID_JSON", "request body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function parsePagination(url: URL): { limit: number; offset: number } {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  return { limit, offset: (page - 1) * limit };
}

async function handle(req: IncomingMessage, res: ServerResponse, service: HydroService): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/health") {
      send(res, 200, { status: "ok" });
      return;
    }

    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/terrains") {
      send(res, 201, service.importTerrain((await readJson(req)) as never));
      return;
    }
    if (method === "POST" && path === "/terrains/generate") {
      send(res, 201, service.generateTerrain((await readJson(req)) as never));
      return;
    }
    if (method === "GET" && path === "/terrains") {
      const { limit, offset } = parsePagination(url);
      send(res, 200, service.repo.listTerrains(limit, offset));
      return;
    }
    if ((m = path.match(/^\/terrains\/(\d+)$/))) {
      if (method === "GET") {
        const t = service.repo.getTerrain(Number(m[1]));
        if (!t) throw apiError(404, "NOT_FOUND", "terrain not found");
        send(res, 200, t);
        return;
      }
    }
    if ((m = path.match(/^\/terrains\/(\d+)\/inspect$/)) && method === "GET") {
      send(res, 200, service.inspectTerrain(Number(m[1])));
      return;
    }
    if ((m = path.match(/^\/terrains\/(\d+)\/pour-points$/))) {
      const tid = Number(m[1]);
      if (method === "POST") {
        send(res, 201, service.addPourPoint(tid, (await readJson(req)) as never));
        return;
      }
      if (method === "GET") {
        const { limit, offset } = parsePagination(url);
        send(res, 200, service.repo.listPourPoints(tid, limit, offset));
        return;
      }
    }
    if ((m = path.match(/^\/terrains\/(\d+)\/analyses$/))) {
      const tid = Number(m[1]);
      if (method === "POST") {
        const result = service.createAnalysis(tid, (await readJson(req)) as never);
        send(res, result.reused ? 200 : 201, result);
        return;
      }
      if (method === "GET") {
        const { limit, offset } = parsePagination(url);
        send(res, 200, service.repo.listAnalyses(tid, limit, offset));
        return;
      }
    }
    if (method === "GET" && path === "/analyses") {
      const terrainParam = url.searchParams.get("terrainId");
      const { limit, offset } = parsePagination(url);
      send(
        res,
        200,
        service.repo.listAnalyses(terrainParam === null ? null : Number(terrainParam), limit, offset),
      );
      return;
    }
    if ((m = path.match(/^\/analyses\/(\d+)$/)) && method === "GET") {
      send(res, 200, service.getReport(Number(m[1])));
      return;
    }
    if ((m = path.match(/^\/analyses\/(\d+)\/trace\/(\d+)$/)) && method === "GET") {
      send(res, 200, service.tracePath(Number(m[1]), Number(m[2])));
      return;
    }
    if ((m = path.match(/^\/analyses\/(\d+)\/matrix$/)) && method === "GET") {
      const layer = url.searchParams.get("layer") ?? "count";
      send(res, 200, service.exportMatrix(Number(m[1]), layer as never));
      return;
    }
    throw apiError(404, "NOT_FOUND", `no route for ${method} ${path}`);
  } catch (err) {
    const e = err as Partial<ApiError>;
    const status = typeof e.status === "number" ? e.status : 500;
    send(res, status, {
      error: {
        code: e.code ?? "INTERNAL_ERROR",
        message: e.message ?? "internal error",
      },
    });
    if (status === 500) console.error(err);
  }
}

const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const dbPath = process.env.HYDRO_DB ?? join(process.cwd(), ".run", "hydro.db");
  startApi({ dbPath, runDir: join(process.cwd(), ".run") })
    .then(({ port }) => {
      console.log(`hydro API listening on http://127.0.0.1:${port}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
