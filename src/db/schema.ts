export const MIGRATIONS: Array<{ id: number; sql: string }> = [
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
  rows INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  cell_size REAL NOT NULL,
  no_data_value REAL,
  valid_cells INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  raw_matrix TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terrain_id INTEGER NOT NULL,
  fill_strategy TEXT NOT NULL,
  threshold REAL NOT NULL,
  outlet_cells TEXT NOT NULL,
  request_key TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(terrain_id, fill_strategy, threshold, outlet_cells, request_key),
  FOREIGN KEY(terrain_id) REFERENCES terrains(id)
);

CREATE TABLE IF NOT EXISTS analysis_cells (
  analysis_id INTEGER NOT NULL,
  cell_index INTEGER NOT NULL,
  row_no INTEGER NOT NULL,
  col_no INTEGER NOT NULL,
  raw_z REAL,
  eff_z REAL,
  delta REAL NOT NULL,
  source_state INTEGER NOT NULL,
  dir_code INTEGER NOT NULL,
  receiver INTEGER NOT NULL,
  upstream_cells REAL NOT NULL,
  accumulation_area REAL NOT NULL,
  PRIMARY KEY(analysis_id, cell_index),
  FOREIGN KEY(analysis_id) REFERENCES analyses(id)
);

CREATE TABLE IF NOT EXISTS depressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL,
  pour_point INTEGER NOT NULL,
  spill_cell INTEGER,
  spill_elevation REAL,
  cell_count INTEGER NOT NULL,
  closed INTEGER NOT NULL,
  raised_cells TEXT NOT NULL,
  FOREIGN KEY(analysis_id) REFERENCES analyses(id)
);

CREATE TABLE IF NOT EXISTS watersheds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL,
  outlet_cell INTEGER NOT NULL,
  cell_count INTEGER NOT NULL,
  area REAL NOT NULL,
  members TEXT NOT NULL,
  FOREIGN KEY(analysis_id) REFERENCES analyses(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(analysis_id) REFERENCES analyses(id)
);
`,
  },
];
