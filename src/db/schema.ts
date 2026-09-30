export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS terrains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      nrows INTEGER NOT NULL,
      ncols INTEGER NOT NULL,
      cell_size REAL NOT NULL,
      elev BLOB NOT NULL,
      nodata_mask BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pour_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terrain_id INTEGER NOT NULL REFERENCES terrains(id),
      row_index INTEGER NOT NULL,
      col_index INTEGER NOT NULL,
      cell_id INTEGER NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(terrain_id, cell_id)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terrain_id INTEGER NOT NULL REFERENCES terrains(id),
      fill_strategy TEXT NOT NULL,
      threshold_count INTEGER NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      UNIQUE(terrain_id, params_hash)
    );
    CREATE TABLE IF NOT EXISTS analysis_pourpoints (
      analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
      pour_point_id INTEGER NOT NULL REFERENCES pour_points(id),
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (analysis_id, pour_point_id)
    );
    CREATE TABLE IF NOT EXISTS analysis_layers (
      analysis_id INTEGER PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
      dir BLOB NOT NULL,
      downstream BLOB NOT NULL,
      count BLOB NOT NULL,
      area BLOB NOT NULL,
      stream BLOB NOT NULL,
      labels BLOB NOT NULL,
      status BLOB NOT NULL,
      processed_elev BLOB NOT NULL,
      raise_amount BLOB NOT NULL,
      drains_evidence BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_terrains_created ON terrains(created_at);
    CREATE INDEX IF NOT EXISTS idx_pourpoints_terrain ON pour_points(terrain_id);
    CREATE INDEX IF NOT EXISTS idx_analyses_terrain ON analyses(terrain_id);
    `,
  },
];
