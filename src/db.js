'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.PMBTC_DB || path.join(__dirname, '..', 'pmbtc.db');

function open() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS buckets (
      start_ts     INTEGER PRIMARY KEY,
      slug         TEXT NOT NULL,
      question     TEXT,
      condition_id TEXT,
      up_token     TEXT,
      down_token   TEXT,
      ref_price    REAL,   -- chainlink btc/usd en el arranque del bucket
      ref_ts       INTEGER,
      final_price  REAL,   -- chainlink btc/usd en el cierre
      final_ts     INTEGER,
      outcome      TEXT,   -- 'Up' | 'Down', calculado con ref/final
      settled_up   REAL,   -- outcomePrices de gamma tras el cierre (verificación)
      created_at   INTEGER
    );


    -- Un tick por muestreo: estado del libro + precio del subyacente.
    CREATE TABLE IF NOT EXISTS ticks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      start_ts     INTEGER NOT NULL,
      ts           INTEGER NOT NULL,  -- ms
      t_left       REAL NOT NULL,     -- segundos hasta el cierre
      cl_price     REAL,              -- chainlink btc/usd
      cl_ts        INTEGER,
      bn_price     REAL,              -- binance btcusdt
      bn_ts        INTEGER,
      ref_price    REAL,
      up_bid       REAL, up_bid_sz REAL,
      up_ask       REAL, up_ask_sz REAL,
      down_bid     REAL, down_bid_sz REAL,
      down_ask     REAL, down_ask_sz REAL,
      up_depth_usd REAL,              -- USD disponibles en asks de Up
      dn_depth_usd REAL,
      UNIQUE (start_ts, ts)
    );
    CREATE INDEX IF NOT EXISTS ticks_bucket ON ticks (start_ts, ts);

    -- Serie de 1s del subyacente, independiente del muestreo del libro.
    CREATE TABLE IF NOT EXISTS underlying (
      source TEXT NOT NULL,
      ts     INTEGER NOT NULL,
      price  REAL NOT NULL,
      PRIMARY KEY (source, ts)
    ) WITHOUT ROWID;
  `);
  migrate(db);
  return db;
}

// Columnas añadidas después de la primera versión del esquema.
// `*_offset_ms` guarda a qué distancia del corte estaba el tick usado: 0 es
// exacto, y cualquier otra cosa es una aproximación que el análisis debe poder
// filtrar. `*_source` distingue el dato medido del inferido por encadenado.
const ADDED = {
  ref_offset_ms: 'INTEGER',
  final_offset_ms: 'INTEGER',
  ref_source: 'TEXT',   // 'feed' | 'chain' | NULL
  final_source: 'TEXT',
  // 'computed' = derivado de ref/cierre propios; 'settlement' = la resolución
  // real de Polymarket, que es ground truth y no necesita precios locales.
  outcome_source: 'TEXT',
};

function migrate(db) {
  const have = new Set(db.prepare('PRAGMA table_info(buckets)').all().map((c) => c.name));
  for (const [col, type] of Object.entries(ADDED)) {
    if (!have.has(col)) db.exec(`ALTER TABLE buckets ADD COLUMN ${col} ${type}`);
  }
}

module.exports = { open, DB_PATH };
