import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { startServer } from "../src/api/server.ts";

const DB_PATH = "tmp/api-test.sqlite";
let base: string;
let close: () => void;

before(async () => {
  rmSync(DB_PATH, { force: true });
  const s = await startServer({
    dbPath: DB_PATH,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
});

after(() => {
  close();
  rmSync(DB_PATH, { force: true });
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(base + path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

test("health", async () => {
  const r = await api("/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "ok");
});

test("rejects invalid terrain with explicit error code", async () => {
  const r = await api("/terrains", {
    method: "POST",
    body: JSON.stringify({ name: "", cellSize: 0, matrix: [] }),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.error.code);
});

test("creates terrain, runs analysis, returns machine report", async () => {
  const matrix = [
    [9, 8, 7, 8, 9],
    [8, 6, 5, 6, 8],
    [7, 5, 3, 5, 7],
    [8, 6, 2, 6, 8],
    [9, 8, 1, 8, 9],
  ];
  const created = await api("/terrains", {
    method: "POST",
    body: JSON.stringify({ name: "valley", cellSize: 2, matrix }),
  });
  assert.equal(created.status, 201);
  const terrainId = created.json.id;

  const analysis = await api(`/terrains/${terrainId}/analyses`, {
    method: "POST",
    body: JSON.stringify({
      fillStrategy: "fill",
      threshold: 3,
      outlets: [{ row: 4, col: 2 }],
      requestKey: "run-1",
    }),
  });
  assert.equal(analysis.status, 201);
  const aid = analysis.json.id;

  const again = await api(`/terrains/${terrainId}/analyses`, {
    method: "POST",
    body: JSON.stringify({
      fillStrategy: "fill",
      threshold: 3,
      outlets: [{ row: 4, col: 2 }],
      requestKey: "run-1",
    }),
  });
  assert.equal(again.json.id, aid, "repeat submission is idempotent");

  const report = await api(`/analyses/${aid}/report`);
  assert.equal(report.status, 200);
  assert.equal(report.json.terrain.cellArea, 4);

  const trace = await api(`/analyses/${aid}/trace/0/0`);
  assert.equal(trace.status, 200);
  assert.ok(Array.isArray(trace.json.path));

  const csv = await fetch(
    `${base}/analyses/${aid}/matrix/direction?format=csv`,
  );
  assert.equal(csv.status, 200);
  assert.ok((await csv.text()).includes(","));

  const ws = await api(`/analyses/${aid}/matrix/watershed?outlet=22`);
  assert.equal(ws.status, 200);
});

test("outlet on NoData is rejected", async () => {
  const created = await api("/terrains", {
    method: "POST",
    body: JSON.stringify({
      name: "hole",
      cellSize: 1,
      matrix: [
        [1, 1, 1],
        [1, null, 1],
        [1, 1, 1],
      ],
    }),
  });
  const id = created.json.id;
  const r = await api(`/terrains/${id}/analyses`, {
    method: "POST",
    body: JSON.stringify({
      fillStrategy: "fill",
      threshold: 1,
      outlets: [{ row: 1, col: 1 }],
    }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "OUTLET_NODATA");
});

test("pagination metadata is correct", async () => {
  for (let i = 0; i < 3; i++) {
    await api("/terrains", {
      method: "POST",
      body: JSON.stringify({
        name: `p${i}`,
        cellSize: 1,
        matrix: [
          [2, 1],
          [1, 0],
        ],
      }),
    });
  }
  const r = await api("/terrains?limit=2&offset=0");
  assert.equal(r.json.limit, 2);
  assert.equal(r.json.items.length, 2);
  assert.equal(r.json.hasMore, true);
  const r2 = await api("/terrains?limit=5000");
  assert.equal(r2.status, 400);
  assert.equal(r2.json.error.code, "INVALID_LIMIT");
});

test("unknown routes and resources return 404 codes", async () => {
  const a = await api("/nope");
  assert.equal(a.status, 404);
  assert.equal(a.json.error.code, "ROUTE_NOT_FOUND");
  const b = await api("/terrains/99999");
  assert.equal(b.status, 404);
});
