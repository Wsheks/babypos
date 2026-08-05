// ============================================================
//  server.js  -  the till's backend. Serves the prototype HTML and
//  a small REST API so products, sales and stock survive a refresh.
//
//  Zero external dependencies: pure node:http + node:sqlite.
//  Start with:  node server.js   (Node 22 or newer)
// ============================================================
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, now, transaction } = require('./db');

const PORT = process.env.PORT || 4100;
// Find the front-end file whether it sits next to server.js (flat deploy) or one level up (dev layout).
const HTML_FILE = [
  path.join(__dirname, 'babyshop-pos-friendly.html'),
  path.join(__dirname, '..', 'babyshop-pos-friendly.html'),
].find(f => fs.existsSync(f)) || path.join(__dirname, 'babyshop-pos-friendly.html');

// method code -> label used by the front end (matches the prototype)
const METHOD_LABEL = { mpesa: 'M-PESA', card: 'Card', cash: 'Cash', split: 'Split payment' };

// on/off settings the Settings screen can save (stored as '1'/'0')
const TOGGLE_KEYS = [
  'vat_registered',
  'pay_mpesa', 'pay_card', 'pay_cash', 'pay_split',
  'etims_receipts', 'receipt_whatsapp',
  'chan_tiktok', 'chan_whatsapp_catalogue', 'chan_hide_out_of_stock', 'chan_next_size_reminder',
  'warn_low_stock', 'must_count_cash',
];

// ---------------------------------------------------------------
//  Read helpers: shape each row to the exact keys the front end uses
// ---------------------------------------------------------------
function productOut(r) {
  return { id: r.id, n: r.name, a: r.age_range, p: r.selling_price, s: r.stock_qty,
           c: r.cost_price, sku: r.sku, bc: r.barcode, recv: r.received,
           vt: r.vat_type || 'standard',
           category: r.category || '', kind: r.kind || '',
           ageMin: r.age_min, ageMax: r.age_max,
           sizes: safeArr(r.sizes), colours: safeArr(r.colours),
           wasPrice: r.was_price || null, image: r.image || '',
           online: r.online == null ? 1 : r.online, featured: r.featured ? 1 : 0 };
}
function safeArr(s) { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

// Guess a garment type from the name so the website has artwork even if kind wasn't set.
function deriveKind(name) {
  const n = (name || '').toLowerCase();
  const map = ['bodysuit', 'onesie', 'vest', 'trousers', 'dungaree', 'dress', 'mitten',
               'receiving', 'inner set', 'blanket', 'tracksuit', 'jacket'];
  for (const k of map) if (n.includes(k)) return k.charAt(0).toUpperCase() + k.slice(1);
  if (n.includes('shoe') || n.includes('boot')) return 'Shoes';
  if (n.includes('towel')) return 'Blanket';
  return 'Top';
}
// Turn our free-text age range ("2 to 3 years", "0 to 3 months", "Newborn") into numeric years.
function deriveAges(ageRange) {
  const t = (ageRange || '').toLowerCase();
  if (t.includes('newborn')) return { min: 0, max: 1 };
  const nums = (t.match(/\d+/g) || []).map(Number);
  if (t.includes('month')) return { min: 0, max: 1 };
  if (nums.length >= 2) return { min: nums[0], max: nums[1] };
  if (nums.length === 1) return { min: nums[0], max: nums[0] };
  return { min: 0, max: 10 };
}
function allProducts() {
  return db.prepare('SELECT * FROM products ORDER BY id').all().map(productOut);
}
function saleOut(s) {
  const lines = db.prepare('SELECT * FROM sale_lines WHERE sale_id = ?').all(s.id);
  return {
    t: (s.datetime || '').slice(11, 16) || (s.datetime || ''),
    ref: s.ref,
    cust: s.customer,
    method: METHOD_LABEL[s.method] || s.method,
    amt: s.total,
    vat: s.vat,
    cashier: s.cashier,
    items: lines.map(l => [l.name, l.qty, l.unit_price]),
  };
}
function allSales() {
  return db.prepare('SELECT * FROM sales ORDER BY datetime DESC, id DESC').all().map(saleOut);
}
function heldOut(h) {
  return { id: h.id, type: h.type, cust: h.customer, deposit: h.deposit,
           lines: JSON.parse(h.lines || '[]'), at: h.at };
}
function allHeld() {
  return db.prepare('SELECT * FROM held_sales ORDER BY id DESC').all().map(heldOut);
}
function orderOut(o) {
  return { id: o.id, ch: o.channel, cust: o.customer, area: o.area,
           items: JSON.parse(o.items || '[]'), amt: o.amount,
           pay: o.pay_status, st: o.fulfil_status, t: o.t };
}
function allOrders() {
  return db.prepare('SELECT * FROM orders ORDER BY id').all().map(orderOut);
}
function allReturns() {
  return db.prepare('SELECT * FROM returns ORDER BY id').all().map(r =>
    ({ c: r.customer, item: r.item, why: r.reason, d: r.at, act: r.action, st: r.status, v: r.value }));
}
function pendingDelivery() {
  const d = db.prepare("SELECT * FROM deliveries WHERE status = 'pending' ORDER BY id LIMIT 1").get();
  if (!d) return { delivery: null, intake: [] };
  const lines = db.prepare('SELECT * FROM delivery_lines WHERE delivery_id = ?').all(d.id);
  return {
    delivery: { id: d.id, ref: d.ref, supplier: d.supplier, landed: d.landed, expected: d.expected_total },
    intake: lines.map(l => ({ n: l.name, a: l.age_range, exp: l.expected, got: l.counted,
                              cost: l.cost, sell: l.sell, st: l.state })),
  };
}
function settingsOut() {
  const out = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => { out[r.key] = r.value; });
  return out;
}
function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function getVatRate() {
  const r = Number(getSetting('vat_rate', '16'));
  return Number.isFinite(r) && r >= 0 ? r : 0;
}
// A shop that is not VAT-registered (default) must not charge VAT to customers.
function isVatRegistered() { return getSetting('vat_registered', '0') === '1'; }
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function nextRef() {
  const row = db.prepare("SELECT MAX(CAST(ref AS INTEGER)) AS m FROM sales").get();
  const n = (row && row.m ? row.m : 0) + 1;
  return String(n).padStart(4, '0');
}

// find a product for a cart/delivery line: by id first, else exact name+age, else name prefix
function matchProduct(line) {
  if (line.id) {
    const byId = db.prepare('SELECT * FROM products WHERE id = ?').get(line.id);
    if (byId) return byId;
  }
  if (line.n && line.a) {
    const byNa = db.prepare('SELECT * FROM products WHERE name = ? AND age_range = ?').get(line.n, line.a);
    if (byNa) return byNa;
  }
  if (line.n) {
    const byName = db.prepare('SELECT * FROM products WHERE name = ?').get(line.n);
    if (byName) return byName;
  }
  return null;
}

// ---------------------------------------------------------------
//  Write actions
// ---------------------------------------------------------------
function recordSale(body) { return transaction(() => {
  const lines = Array.isArray(body.lines) ? body.lines : [];
  // Resolve each line to its product once (used for VAT status and stock).
  const resolved = lines.map(l => {
    const prod = matchProduct(l);
    return { l, prod, exempt: prod ? (prod.vat_type === 'exempt') : false, lineTotal: l.p * l.q };
  });
  const subtotal = resolved.reduce((t, x) => t + x.lineTotal, 0);
  const discPct = Number(body.discountPct) || 0;
  const total = Number.isFinite(body.total) ? body.total : Math.round(subtotal * (1 - discPct / 100));
  const discAmount = subtotal - total;

  // VAT is the tax inside the standard-rated lines only, after apportioning the
  // discount across the whole sale. Exempt lines and a 0% rate contribute nothing.
  // If the shop is not VAT-registered, no VAT is charged on anything (rate 0).
  const r = isVatRegistered() ? getVatRate() : 0;
  const standardSub = resolved.reduce((t, x) => t + (x.exempt ? 0 : x.lineTotal), 0);
  const taxableStandard = subtotal > 0 ? standardSub - discAmount * (standardSub / subtotal) : 0;
  const vat = r > 0 ? Math.round(taxableStandard * r / (100 + r)) : 0;

  const method = body.method || 'mpesa';
  const ref = nextRef();
  const dt = localStamp();

  const saleId = db.prepare(
    `INSERT INTO sales (ref, datetime, cashier, customer, subtotal, discount_pct, discount_amount, vat, total, method, split_parts, status, channel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`
  ).run(ref, dt, body.cashier || null, body.customer || 'Walk-in', subtotal, discPct, discAmount, vat, total,
        method, body.splitParts ? JSON.stringify(body.splitParts) : null, body.channel || 'counter').lastInsertRowid;

  const insLine = db.prepare(
    `INSERT INTO sale_lines (sale_id, product_id, name, age_range, qty, unit_price) VALUES (?, ?, ?, ?, ?, ?)`);
  const insMove = db.prepare(
    `INSERT INTO stock_movements (product_id, type, qty, ref, datetime, user) VALUES (?, 'sale', ?, ?, ?, ?)`);
  const decStock = db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?');

  resolved.forEach(({ l, prod }) => {
    const label = l.a ? `${l.n}, ${l.a}` : l.n;
    insLine.run(saleId, prod ? prod.id : null, label, l.a || null, l.q, l.p);
    if (prod) {
      decStock.run(l.q, prod.id);
      insMove.run(prod.id, -l.q, ref, dt, body.cashier || null);
    }
  });

  const sale = saleOut(db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId));
  return { sale, products: allProducts() };
}); }

function acceptDelivery(id) { return transaction(() => {
  const d = db.prepare("SELECT * FROM deliveries WHERE id = ? AND status = 'pending'").get(id);
  if (!d) return null;
  const lines = db.prepare("SELECT * FROM delivery_lines WHERE delivery_id = ? AND state = 'ok'").all(id);
  const insMove = db.prepare(
    `INSERT INTO stock_movements (product_id, type, qty, ref, datetime, user) VALUES (?, 'delivery', ?, ?, ?, ?)`);
  const addStock = db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?');
  const dt = localStamp();
  const catalogue = db.prepare('SELECT * FROM products').all();
  let added = 0;
  lines.forEach(l => {
    // the prototype matches a delivery line to a product by name prefix
    const prod = catalogue.find(x => x.name.indexOf(l.name) === 0);
    if (prod) {
      addStock.run(l.counted, prod.id);
      insMove.run(prod.id, l.counted, d.ref, dt, null);
      added += l.counted;
    }
  });
  db.prepare("UPDATE deliveries SET status = 'accepted' WHERE id = ?").run(id);
  return { added, products: allProducts(), ...pendingDelivery() };
}); }

// Build the public shop catalogue (products.json) in the exact shape ilekela-shop.html
// expects. Robust defaults guarantee every item is valid so the website never breaks.
function buildCatalogue() {
  const rows = db.prepare('SELECT * FROM products WHERE online = 1 ORDER BY id').all();
  return rows.map(r => {
    const ages = (r.age_min != null && r.age_max != null) ? { min: r.age_min, max: r.age_max } : deriveAges(r.age_range);
    const sizes = safeArr(r.sizes);
    const colours = safeArr(r.colours);
    const item = {
      sku: r.sku || ('IK-' + r.id),
      name: r.name,
      kind: r.kind || deriveKind(r.name),
      category: r.category || 'Other',
      ageMin: Number(ages.min) || 0,
      ageMax: Number(ages.max) || 0,
      price: r.selling_price || 0,
      stock: r.stock_qty || 0,
      sizes: sizes.length ? sizes : ['One size'],
      colours: colours.length ? colours : ['teal'],
      tags: r.featured ? ['featured'] : [],
      image: r.image || '',
    };
    if (r.was_price && r.was_price > r.selling_price) item.wasPrice = r.was_price;
    return item;
  });
}

function addProduct(body) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  const sku = body.sku || 'ILK-NEW-' + String(count + 1).padStart(3, '0');
  const vatType = body.vat_type === 'exempt' ? 'exempt' : 'standard';
  const ages = deriveAges(body.a);
  const kind = (body.kind && String(body.kind).trim()) || deriveKind(body.n);
  const sizes = Array.isArray(body.sizes) ? body.sizes : [];
  const colours = Array.isArray(body.colours) ? body.colours : [];
  const id = db.prepare(
    `INSERT INTO products (name, age_range, category, cost_price, selling_price, stock_qty, sku, barcode, received, created_at, vat_type,
       kind, age_min, age_max, sizes, colours, was_price, image, online, featured)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'today', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(body.n, body.a || 'All ages', body.category || null, Number(body.c) || 0, Number(body.p) || 0, Number(body.s) || 0,
        sku, null, now(), vatType,
        kind, ages.min, ages.max, JSON.stringify(sizes), JSON.stringify(colours),
        Number(body.was_price) || null, body.image || null,
        body.online === false || body.online === 0 ? 0 : 1, body.featured ? 1 : 0).lastInsertRowid;
  // give it a barcode in the prototype's style
  const bc = '629' + String(1041500 + (id * 137)).slice(-7);
  db.prepare('UPDATE products SET barcode = ? WHERE id = ?').run(bc, id);
  if (Number(body.s) > 0) {
    db.prepare(`INSERT INTO stock_movements (product_id, type, qty, ref, datetime, user) VALUES (?, 'adjust', ?, 'opening', ?, ?)`)
      .run(id, Number(body.s), now(), body.cashier || null);
  }
  return productOut(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}

function addHeld(body) {
  const id = db.prepare(
    `INSERT INTO held_sales (type, customer, deposit, lines, at, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(body.type || 'hold', body.cust || 'Walk-in', Number(body.deposit) || 0,
        JSON.stringify(body.lines || []), body.at || 'Held just now', now()).lastInsertRowid;
  return heldOut(db.prepare('SELECT * FROM held_sales WHERE id = ?').get(id));
}

function advanceOrder(id, st) {
  db.prepare('UPDATE orders SET fulfil_status = ? WHERE id = ?').run(st, id);
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return o ? orderOut(o) : null;
}

// local timestamp "YYYY-MM-DD HH:MM" so Reports shows the right till time
function localStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------
//  HTTP plumbing
// ---------------------------------------------------------------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const method = req.method;

  try {
    // ---- API ----
    if (p === '/api/bootstrap' && method === 'GET') {
      const del = pendingDelivery();
      return sendJSON(res, 200, {
        shop: settingsOut(),
        products: allProducts(),
        sales: allSales(),
        held: allHeld(),
        orders: allOrders(),
        returns: allReturns(),
        intake: del.intake,
        delivery: del.delivery,
      });
    }

    if (p === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      const uname = String(body.username || '').trim().toLowerCase();
      const pw = String(body.password || '');
      const row = db.prepare('SELECT * FROM staff WHERE lower(username) = ?').get(uname);
      if (!row || row.password !== pw) return sendJSON(res, 401, { error: 'Wrong username or password' });
      return sendJSON(res, 200, { user: { name: row.name, role: row.role, c: row.color, username: row.username } });
    }

    if (p === '/api/sales' && method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, recordSale(body));
    }

    if (p === '/api/products' && method === 'POST') {
      const body = await readBody(req);
      if (!body.n || !String(body.n).trim()) return sendJSON(res, 400, { error: 'name required' });
      return sendJSON(res, 200, { product: addProduct(body) });
    }

    // Save shop settings (whitelisted so unknown keys are ignored).
    if (p === '/api/settings' && method === 'PATCH') {
      const body = await readBody(req);
      if (body.vat_rate !== undefined) {
        const r = Math.round(Number(body.vat_rate));
        if (!Number.isFinite(r) || r < 0 || r > 100) return sendJSON(res, 400, { error: 'VAT rate must be a whole number between 0 and 100' });
        setSetting('vat_rate', r);
      }
      // On/off toggles, stored as '1'/'0'.
      TOGGLE_KEYS.forEach(k => {
        if (body[k] !== undefined) setSetting(k, (body[k] === '1' || body[k] === 1 || body[k] === true) ? '1' : '0');
      });
      return sendJSON(res, 200, { shop: settingsOut() });
    }

    // Public shop catalogue — preview, live file, and publish.
    if (p === '/api/catalogue.json' && method === 'GET') {
      return sendJSON(res, 200, buildCatalogue());
    }
    if (p === '/products.json' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(buildCatalogue()));
    }
    if (p === '/api/catalogue/publish' && method === 'POST') {
      const arr = buildCatalogue();
      const dir = path.join(__dirname, 'published');
      fs.mkdirSync(dir, { recursive: true });
      const finalPath = path.join(dir, 'products.json');
      const tmp = finalPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));   // temp-then-move: a reader never sees a half file
      fs.renameSync(tmp, finalPath);
      setSetting('catalogue_published_at', new Date().toISOString());
      setSetting('catalogue_count', arr.length);
      // Seam: when the shop droplet's host + SSH key are configured, scp/rsync finalPath to its web root here.
      return sendJSON(res, 200, { count: arr.length, at: getSetting('catalogue_published_at'), path: finalPath });
    }

    let m;
    // Update a product: VAT status, website catalogue fields, online/featured flags.
    if ((m = p.match(/^\/api\/products\/(\d+)$/)) && method === 'PATCH') {
      const body = await readBody(req);
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(m[1]));
      if (!prod) return sendJSON(res, 404, { error: 'no such product' });
      const set = (col, val) => db.prepare(`UPDATE products SET ${col} = ? WHERE id = ?`).run(val, prod.id);
      if (body.vat_type !== undefined) set('vat_type', body.vat_type === 'exempt' ? 'exempt' : 'standard');
      if (body.category !== undefined) set('category', body.category || null);
      if (body.kind !== undefined) set('kind', body.kind || null);
      if (body.sizes !== undefined) set('sizes', JSON.stringify(Array.isArray(body.sizes) ? body.sizes : []));
      if (body.colours !== undefined) set('colours', JSON.stringify(Array.isArray(body.colours) ? body.colours : []));
      if (body.was_price !== undefined) set('was_price', Number(body.was_price) || null);
      if (body.image !== undefined) set('image', body.image || null);
      if (body.online !== undefined) set('online', (body.online === true || body.online === 1 || body.online === '1') ? 1 : 0);
      if (body.featured !== undefined) set('featured', (body.featured === true || body.featured === 1 || body.featured === '1') ? 1 : 0);
      return sendJSON(res, 200, { product: productOut(db.prepare('SELECT * FROM products WHERE id = ?').get(prod.id)) });
    }
    if ((m = p.match(/^\/api\/deliveries\/(\d+)\/accept$/)) && method === 'POST') {
      const result = acceptDelivery(Number(m[1]));
      if (!result) return sendJSON(res, 404, { error: 'no pending delivery' });
      return sendJSON(res, 200, result);
    }

    if (p === '/api/held' && method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, { held: addHeld(body) });
    }
    if ((m = p.match(/^\/api\/held\/(\d+)$/)) && method === 'DELETE') {
      db.prepare('DELETE FROM held_sales WHERE id = ?').run(Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }

    if ((m = p.match(/^\/api\/orders\/(\d+)$/)) && method === 'PATCH') {
      const body = await readBody(req);
      const o = advanceOrder(Number(m[1]), body.st);
      if (!o) return sendJSON(res, 404, { error: 'no such order' });
      return sendJSON(res, 200, { order: o });
    }
    if ((m = p.match(/^\/api\/orders\/(\d+)$/)) && method === 'DELETE') {
      db.prepare('DELETE FROM orders WHERE id = ?').run(Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) return sendJSON(res, 404, { error: 'not found' });

    // ---- static: the prototype HTML ----
    if ((p === '/' || p === '/index.html' || p === '/babyshop-pos-friendly.html') && method === 'GET') {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    sendJSON(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Babyshop POS  ->  http://localhost:${PORT}`);
});
