// ============================================================
//  db.js  -  opens the SQLite database, applies the schema and
//  seeds it once with the prototype's sample data so every screen
//  looks identical on first load.
//
//  Uses Node's built in SQLite (node:sqlite, stable from Node 22).
//  No native build step, no npm install. See README for deploy notes.
// ============================================================
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.POS_DB || path.join(__dirname, 'pos.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// node:sqlite has no transaction() helper, so wrap BEGIN/COMMIT ourselves.
function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------------------------------------------------------------
//  Schema (idempotent). Mirrors the data model in HANDOFF.md.
// ---------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  age_range     TEXT,
  category      TEXT,
  cost_price    INTEGER NOT NULL DEFAULT 0,
  selling_price INTEGER NOT NULL DEFAULT 0,
  stock_qty     INTEGER NOT NULL DEFAULT 0,
  sku           TEXT,
  barcode       TEXT,
  supplier      TEXT,
  reorder_level INTEGER NOT NULL DEFAULT 5,
  received      TEXT,
  created_at    TEXT,
  vat_type      TEXT NOT NULL DEFAULT 'standard',  -- 'standard' (shop rate) | 'exempt' (no VAT)
  -- fields for the public shop website catalogue (products.json)
  kind          TEXT,                              -- garment type, drives the site artwork
  age_min       INTEGER,                           -- years (0 = newborn)
  age_max       INTEGER,
  sizes         TEXT,                              -- JSON array of size chips
  colours       TEXT,                              -- JSON array of PALETTE colour keys
  was_price     INTEGER,                           -- strike-through price when higher than price
  image         TEXT,                              -- image URL (else site draws a placeholder)
  online        INTEGER NOT NULL DEFAULT 1,        -- 1 = include in the website catalogue
  featured      INTEGER NOT NULL DEFAULT 0         -- 1 = show in the "Picked for you" rail
);

CREATE TABLE IF NOT EXISTS sales (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT,
  datetime        TEXT,
  cashier         TEXT,
  customer        TEXT,
  subtotal        INTEGER NOT NULL DEFAULT 0,
  discount_pct    INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  vat             INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  method          TEXT,
  split_parts     TEXT,
  status          TEXT NOT NULL DEFAULT 'paid',
  channel         TEXT NOT NULL DEFAULT 'counter'
);

CREATE TABLE IF NOT EXISTS sale_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER,
  name       TEXT,
  age_range  TEXT,
  qty        INTEGER NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  type       TEXT,                       -- delivery | sale | return | adjust
  qty        INTEGER NOT NULL DEFAULT 0, -- signed: +in, -out
  ref        TEXT,
  datetime   TEXT,
  user       TEXT
);

CREATE TABLE IF NOT EXISTS deliveries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref            TEXT,
  supplier       TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted
  landed         TEXT,
  expected_total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS delivery_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  name        TEXT,
  age_range   TEXT,
  expected    INTEGER NOT NULL DEFAULT 0,
  counted     INTEGER NOT NULL DEFAULT 0,
  cost        INTEGER NOT NULL DEFAULT 0,
  sell        INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'ok'           -- ok | short | damaged
);

CREATE TABLE IF NOT EXISTS held_sales (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL DEFAULT 'hold',         -- hold | reserve
  customer   TEXT,
  deposit    INTEGER NOT NULL DEFAULT 0,
  lines      TEXT,                                 -- JSON array of {n,a,q,p}
  at         TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT,
  channel        TEXT,                             -- wa | tt
  customer       TEXT,
  area           TEXT,
  items          TEXT,                             -- JSON array of [name, qty]
  amount         INTEGER NOT NULL DEFAULT 0,
  pay_status     TEXT NOT NULL DEFAULT 'await',    -- paid | await
  fulfil_status  TEXT NOT NULL DEFAULT 'new',      -- new | packed | rider | delivered
  t              TEXT,
  created_at     TEXT
);

CREATE TABLE IF NOT EXISTS returns (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT,
  item     TEXT,
  reason   TEXT,
  at       TEXT,
  action   TEXT,
  status   TEXT NOT NULL DEFAULT 'open',           -- done | wait | open
  value    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT,
  phone    TEXT,
  children TEXT
);

CREATE TABLE IF NOT EXISTS staff (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT,
  username TEXT,
  role     TEXT,
  password TEXT,          -- demo password for now; step 2 replaces with a real hash
  color    TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT,
  role       TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS resets (
  token      TEXT PRIMARY KEY,
  username   TEXT,
  expires_at TEXT
);
`);

// ---------------------------------------------------------------
//  Migrations for databases created before a column existed.
//  CREATE TABLE IF NOT EXISTS never alters an existing table, so add
//  new columns here when missing (keeps existing data, no reseed).
// ---------------------------------------------------------------
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('products', 'vat_type', "TEXT NOT NULL DEFAULT 'standard'");
ensureColumn('products', 'kind', 'TEXT');
ensureColumn('products', 'age_min', 'INTEGER');
ensureColumn('products', 'age_max', 'INTEGER');
ensureColumn('products', 'sizes', 'TEXT');
ensureColumn('products', 'colours', 'TEXT');
ensureColumn('products', 'was_price', 'INTEGER');
ensureColumn('products', 'image', 'TEXT');
ensureColumn('products', 'online', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('products', 'featured', 'INTEGER NOT NULL DEFAULT 0');

// ---------------------------------------------------------------
//  Seed once. Data ported verbatim from the prototype so the first
//  render is byte-for-byte the same shop.
// ---------------------------------------------------------------
function seed() {
  const already = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (already > 0) return;

  transaction(() => {
    // --- products (barcodes computed exactly as the prototype did) ---
    const PRODUCTS = [
      { n: 'Fleece half jacket', a: '2 to 3 years', p: 2400, s: 14, c: 1340, sku: 'ILK-HJ-023', recv: '26 Jul' },
      { n: 'Cotton bodysuit set, 3 pieces', a: '0 to 3 months', p: 1800, s: 22, c: 980, sku: 'ILK-BS-003', recv: '26 Jul' },
      { n: 'Soft sole baby shoes', a: '6 to 9 months', p: 1500, s: 3, c: 840, sku: 'ILK-SH-069', recv: '12 Jun' },
      { n: 'Denim trousers', a: '4 to 5 years', p: 2200, s: 11, c: 1210, sku: 'ILK-TR-045', recv: '12 Jun' },
      { n: 'Knit sweater dress', a: '3 to 4 years', p: 2900, s: 7, c: 1610, sku: 'ILK-DR-034', recv: '26 Jul' },
      { n: 'Two piece tracksuit', a: '6 to 7 years', p: 3400, s: 9, c: 1890, sku: 'ILK-TS-067', recv: '26 Jul' },
      { n: 'Warm hooded jacket', a: '8 to 10 years', p: 4200, s: 4, c: 2360, sku: 'ILK-HJ-810', recv: '2 May' },
      { n: 'Hooded bath towel', a: 'Newborn', p: 1900, s: 16, c: 1050, sku: 'ILK-TW-001', recv: '12 Jun' },
    ];
    const insProd = db.prepare(
      `INSERT INTO products (name, age_range, cost_price, selling_price, stock_qty, sku, barcode, received, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    PRODUCTS.forEach((p, i) => {
      const bc = '629' + String(1041500 + i * 137).slice(-7);
      insProd.run(p.n, p.a, p.c, p.p, p.s, p.sku, bc, p.recv, now());
    });

    // --- historical sales (the prototype's TXNS, so Reports matches) ---
    const methodCode = { 'M-PESA': 'mpesa', 'Card': 'card', 'Cash': 'cash' };
    const TXNS = [
      { t: '15:42', ref: '0412', cust: 'Wanjiru K.', method: 'M-PESA', amt: 6000, cashier: 'Njeri M.', items: [['Fleece half jacket, 2 to 3 years', 1, 2400], ['Cotton bodysuit set, 3 pieces', 2, 1800]] },
      { t: '15:10', ref: '0411', cust: 'Walk-in', method: 'Cash', amt: 1500, cashier: 'Njeri M.', items: [['Soft sole baby shoes, 6 to 9 months', 1, 1500]] },
      { t: '14:38', ref: '0410', cust: 'Achieng O.', method: 'Card', amt: 3400, cashier: 'Njeri M.', items: [['Two piece tracksuit, 6 to 7 years', 1, 3400]] },
      { t: '13:55', ref: '0409', cust: 'Mueni S.', method: 'M-PESA', amt: 4700, cashier: 'Njeri M.', items: [['Warm hooded jacket, 8 to 10 years', 1, 4200], ['Ribbed socks, 5 pack', 1, 500]] },
      { t: '13:20', ref: '0408', cust: 'TikTok Shop', method: 'M-PESA', amt: 2900, cashier: 'Online', items: [['Knit sweater dress, 3 to 4 years', 1, 2900]] },
      { t: '12:47', ref: '0407', cust: 'Walk-in', method: 'Cash', amt: 2600, cashier: 'Faith A.', items: [['Cot blanket, Newborn to 2y', 1, 2600]] },
      { t: '11:58', ref: '0406', cust: 'Njoki W.', method: 'M-PESA', amt: 5200, cashier: 'Faith A.', items: [['Denim trousers, 4 to 5 years', 1, 2200], ['Fleece half jacket, 2 to 3 years', 1, 2400], ['Ribbed socks, 5 pack', 1, 600]] },
    ];
    const insSale = db.prepare(
      `INSERT INTO sales (ref, datetime, cashier, customer, subtotal, discount_pct, discount_amount, vat, total, method, split_parts, status, channel)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, 'paid', ?)`);
    const insSaleLine = db.prepare(
      `INSERT INTO sale_lines (sale_id, product_id, name, age_range, qty, unit_price) VALUES (?, ?, ?, ?, ?, ?)`);
    TXNS.forEach(x => {
      const vat = Math.round(x.amt * 16 / 116);
      const channel = x.cashier === 'Online' ? 'online' : 'counter';
      const dt = `2026-07-30 ${x.t}`;
      const r = insSale.run(x.ref, dt, x.cashier, x.cust, x.amt, vat, x.amt, methodCode[x.method] || 'mpesa', channel);
      x.items.forEach(it => insSaleLine.run(r.lastInsertRowid, null, it[0], null, it[1], it[2]));
    });

    // --- pending delivery (the prototype's INTAKE) ---
    const INTAKE = [
      { n: 'Fleece half jacket', a: '2 to 3 years', exp: 24, got: 24, cost: 1340, sell: 2400, st: 'ok' },
      { n: 'Cotton bodysuit set', a: '0 to 3 months', exp: 36, got: 36, cost: 980, sell: 1800, st: 'ok' },
      { n: 'Knit sweater dress', a: '3 to 4 years', exp: 18, got: 16, cost: 1610, sell: 2900, st: 'short' },
      { n: 'Soft sole baby shoes', a: '6 to 9 months', exp: 30, got: 30, cost: 840, sell: 1500, st: 'ok' },
      { n: 'Two piece tracksuit', a: '6 to 7 years', exp: 20, got: 20, cost: 1890, sell: 3400, st: 'damaged' },
    ];
    const expectedTotal = 128; // as shown on the delivery card
    const delId = db.prepare(
      `INSERT INTO deliveries (ref, supplier, status, landed, expected_total) VALUES (?, ?, 'pending', ?, ?)`
    ).run('TR-2607', 'Istanbul', 'Landed 26 July', expectedTotal).lastInsertRowid;
    const insDelLine = db.prepare(
      `INSERT INTO delivery_lines (delivery_id, name, age_range, expected, counted, cost, sell, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    INTAKE.forEach(r => insDelLine.run(delId, r.n, r.a, r.exp, r.got, r.cost, r.sell, r.st));

    // --- held / reserved sales ---
    db.prepare(
      `INSERT INTO held_sales (type, customer, deposit, lines, at, created_at) VALUES ('reserve', ?, ?, ?, ?, ?)`
    ).run('Aisha M.', 1000, JSON.stringify([{ n: 'Warm hooded jacket', a: '8 to 10 years', q: 1, p: 4200 }]), 'Held 14:10', now());

    // --- online orders ---
    const ORDERS = [
      { code: 'WA-2207', ch: 'wa', cust: 'Mercy A.', area: 'Utawala', items: [['Warm hooded jacket, 8 to 10 years', 1]], amt: 4200, pay: 'paid', st: 'new', t: '12 min ago' },
      { code: 'WA-2206', ch: 'wa', cust: 'Faith N.', area: 'Ruai', items: [['Cot blanket, Newborn to 2y', 1]], amt: 2600, pay: 'await', st: 'new', t: '1 hr ago' },
      { code: 'WA-2201', ch: 'wa', cust: 'Grace W.', area: 'Utawala', items: [['Denim trousers, 4 to 5 years', 1], ['Soft sole baby shoes', 1]], amt: 3700, pay: 'paid', st: 'delivered', t: 'Yesterday' },
    ];
    const insOrder = db.prepare(
      `INSERT INTO orders (code, channel, customer, area, items, amount, pay_status, fulfil_status, t, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ORDERS.forEach(o => insOrder.run(o.code, o.ch, o.cust, o.area, JSON.stringify(o.items), o.amt, o.pay, o.st, o.t, now()));

    // --- returns ---
    const RETURNS = [
      { c: 'Wanjiru K.', item: 'Knit sweater dress, 3 to 4 years', why: 'Too small for the child', d: '2 days ago', act: 'Swapped, one size up', st: 'done', v: 2900 },
      { c: 'Achieng O.', item: 'Two piece tracksuit, 6 to 7 years', why: 'A seam came apart', d: 'Today, 11:20', act: 'Refund to M-PESA', st: 'wait', v: 3400 },
      { c: 'Mueni S.', item: 'Soft sole baby shoes, 6 to 9 months', why: 'Bought the wrong size', d: 'Today, 15:45', act: 'Wants a swap', st: 'open', v: 1500 },
    ];
    const insRet = db.prepare(
      `INSERT INTO returns (customer, item, reason, at, action, status, value) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    RETURNS.forEach(r => insRet.run(r.c, r.item, r.why, r.d, r.act, r.st, r.v));

    // --- staff (username + demo password; step 2 replaces with hashes) ---
    const STAFF = [
      ['Wsheks', 'wsheks', 'Owner', 'babyshop', '#39322e'],
      ['Njeri M.', 'njeri', 'Cashier', 'babyshop', '#ec7060'],
      ['Faith A.', 'faith', 'Cashier', 'babyshop', '#ec7060'],
      ['Brian O.', 'brian', 'Stock clerk', 'babyshop', '#12995a'],
      ['Kevin M.', 'kevin', 'Rider', 'babyshop', '#f2a12a'],
    ];
    const insStaff = db.prepare(`INSERT INTO staff (name, username, role, password, color) VALUES (?, ?, ?, ?, ?)`);
    STAFF.forEach(s => insStaff.run(...s));

    // --- settings / shop ---
    const SETTINGS = {
      shop_name: 'ilekela Baby & Kids',
      branch: 'Utawala',
      till: '5297841',
      kra_pin: 'P052xxxxxxG',
      vat_rate: '16',
      opening_float: '3000',
      // not VAT-registered by default (under the KES 5M threshold) -> no VAT charged
      vat_registered: '0',
      // on/off toggles, all on by default (match the prototype)
      pay_mpesa: '1', pay_card: '1', pay_cash: '1', pay_split: '1',
      etims_receipts: '1', receipt_whatsapp: '1',
      chan_tiktok: '1', chan_whatsapp_catalogue: '1', chan_hide_out_of_stock: '1', chan_next_size_reminder: '1',
      warn_low_stock: '1', must_count_cash: '1',
    };
    const insSet = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
    Object.entries(SETTINGS).forEach(([k, v]) => insSet.run(k, v));
  });
}

function now() { return new Date().toISOString(); }

seed();

module.exports = { db, now, transaction };
