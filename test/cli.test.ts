import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CLI = resolve("src/cli/index.ts");
const DB = resolve("tmp/cli-test.sqlite");
const flags = {
  env: { ...process.env, TWSH_DB: DB },
};

function run(args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--experimental-sqlite", CLI, ...args],
    { encoding: "utf8", env: flags.env },
  );
}

test("CLI end-to-end: import, analyze, trace, compare, export", () => {
  rmSync(DB, { force: true });
  const out = run([
    "synthetic",
    "cli-terrain",
    "8",
    "8",
    "--seed",
    "3",
    "--pit",
  ]);
  assert.match(out, /terrain id=1/);

  const dep = run(["depressions", "1", "fill"]);
  assert.match(dep, /AFTER/);

  const an = run([
    "analyze",
    "1",
    "--strategy",
    "fill",
    "--threshold",
    "4",
    "--outlet",
    "7,2",
    "--key",
    "cli-1",
  ]);
  assert.match(an, /analysis=1/);

  // idempotent
  const an2 = run([
    "analyze",
    "1",
    "--strategy",
    "fill",
    "--threshold",
    "4",
    "--outlet",
    "7,2",
    "--key",
    "cli-1",
  ]);
  assert.match(an2, /analysis=1/);

  const trace = run(["trace", "1", "0", "0"]);
  assert.match(trace, /downstream path/);

  const ws = run(["watershed", "1"]);
  assert.match(ws, /outlet cell=/);

  const cmp = run(["compare", "1", "2", "5"]);
  assert.match(cmp, /threshold=2/);
  assert.match(cmp, /threshold=5/);

  const exportOut = resolve("tmp/cli-dir.csv");
  rmSync(exportOut, { force: true });
  const ex = run(["export", "1", "direction", "--csv", "--out", exportOut]);
  assert.match(ex, /wrote/);
  assert.ok(existsSync(exportOut));

  const rep = run(["report", "1"]);
  const json = JSON.parse(rep);
  assert.equal(json.version, 1);
  rmSync(DB, { force: true });
});

test("CLI shows help", () => {
  const h = run(["--help"]);
  assert.match(h, /twsh - raster terrain/);
});
