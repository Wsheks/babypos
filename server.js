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
const crypto = require('node:crypto');
const https = require('node:https');
const { db, now, transaction } = require('./db');

// Mail config lives in mail.json next to server.js (gitignored):
//   {"key":"re_...","from":"ilekela POS <onboarding@resend.dev>","to":"owner@gmail.com"}
// Sent via Resend's HTTPS API (port 443) because cloud hosts block outbound SMTP.
// Absent = email features are simply off (endpoints still respond, just don't send).
function mailConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'mail.json'), 'utf8')); }
  catch (e) { return null; }
}
// Send an email through the Resend HTTPS API. No external packages.
function sendMail({ key, from, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: from || 'ilekela POS <onboarding@resend.dev>',
      to: [to], subject, text,
    });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, r => {
      let buf = ''; r.setEncoding('utf8');
      r.on('data', d => buf += d);
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) resolve(true);
        else reject(new Error('Resend ' + r.statusCode + ': ' + buf));
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('email timeout')); });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// AI product naming config lives in ai.json next to server.js (gitignored):
//   {"key":"sk-ant-...","model":"claude-haiku-4-5"}
// The owner pastes their own Anthropic API key in POS Settings, which writes this file.
// Absent = the feature is simply off (the "Suggest from photo" button hides).
function aiConfigPath() { return path.join(__dirname, 'ai.json'); }
function aiConfig() { try { return JSON.parse(fs.readFileSync(aiConfigPath(), 'utf8')); } catch (e) { return null; } }
function aiEnabled() { const c = aiConfig(); return !!(c && c.key); }
function bgEnabled() { const c = aiConfig(); return !!(c && c.removebg_key); }
// Detect the real image type from the file's first bytes (extensions can lie), for the vision API.
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
}
// One remove.bg call with a given detection type. Returns the processed image as a Buffer (PNG).
// format=png keeps the output a real PNG (with bg_color the result is opaque; format=auto would
// otherwise hand back JPEG bytes and cause a media-type mismatch downstream).
function removeBgOnce({ b64, key, type }) {
  return new Promise((resolve, reject) => {
    const form = 'image_file_b64=' + encodeURIComponent(b64) + '&size=auto&type=' + type + '&bg_color=ffffff&format=png';
    const req = https.request({
      hostname: 'api.remove.bg', path: '/v1.0/removebg', method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    }, r => {
      const chunks = [];
      r.on('data', d => chunks.push(d));
      r.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (r.statusCode >= 200 && r.statusCode < 300) return resolve(buf);
        let m = 'remove.bg ' + r.statusCode;
        try { const j = JSON.parse(buf.toString('utf8')); if (j.errors && j.errors[0] && j.errors[0].title) m = j.errors[0].title; } catch (_) {}
        reject(new Error(m));
      });
    });
    req.setTimeout(40000, () => { req.destroy(); reject(new Error('remove.bg took too long')); });
    req.on('error', reject);
    req.write(form); req.end();
  });
}
// Product mode is best for a single clean item; if it can't find one, retry in auto mode, which
// rescues some hand-held / busier shots. Failed detections don't consume remove.bg credits.
function removeBgViaService({ b64, key }) {
  return removeBgOnce({ b64, key, type: 'product' }).catch(err => {
    if (/foreground/i.test(String((err && err.message) || ''))) return removeBgOnce({ b64, key, type: 'auto' });
    throw err;
  });
}
// Tidy the model's reply into a clean product title.
function cleanTitle(s) {
  s = String(s || '').trim()
    .replace(/^["'“‘\s]+/, '').replace(/["'”’.\s]+$/, '')
    .replace(/\s+/g, ' ').trim();
  if (s.length > 70) s = s.slice(0, 70).replace(/\s+\S*$/, '').trim();
  return s;
}
// Ask a Claude vision model to name the outfit in a photo. Raw HTTPS, no npm deps
// (same approach as sendMail). Returns the suggested title text.
function suggestTitleFromImage({ base64, mediaType, category, cfg }) {
  return new Promise((resolve, reject) => {
    const model = (cfg && cfg.model) || 'claude-haiku-4-5';
    const catLine = category ? ` The product is in the category "${String(category).slice(0, 40)}".` : '';
    const prompt = `You are naming a product for a Kenyan baby and kids clothing shop's online store. Look at the outfit in this photo and write a short, clear product title a parent would understand, about 3 to 6 words. Name the garment (for example a 3-piece baby set, romper, dress, hooded jacket) and its main colour or pattern if you can see it.${catLine} Do not invent brand names. Ignore any price stickers, supplier codes or watermark text printed on the photo. Reply with only the title, with no quotes and no other words.`;
    const payload = JSON.stringify({
      model, max_tokens: 64,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: prompt },
      ] }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': cfg.key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, r => {
      let buf = ''; r.setEncoding('utf8');
      r.on('data', d => buf += d);
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          try {
            const j = JSON.parse(buf);
            const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
            resolve(txt);
          } catch (e) { reject(new Error('Unexpected AI response')); }
        } else {
          let m = 'Anthropic ' + r.statusCode;
          try { const e = JSON.parse(buf); if (e.error && e.error.message) m = e.error.message; } catch (_) {}
          reject(new Error(m));
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('The AI took too long to answer')); });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

const PORT = process.env.PORT || 4100;
// Find the front-end file whether it sits next to server.js (flat deploy) or one level up (dev layout).
const HTML_FILE = [
  path.join(__dirname, 'babyshop-pos-friendly.html'),
  path.join(__dirname, '..', 'babyshop-pos-friendly.html'),
].find(f => fs.existsSync(f)) || path.join(__dirname, 'babyshop-pos-friendly.html');

// Uploaded product photos live here (served at /uploads/..., kept out of git like pos.db).
const UPLOAD_DIR = path.join(__dirname, 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

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
           c: r.cost_price, w: r.wholesale_price || 0, sku: r.sku, bc: r.barcode, recv: r.received,
           vt: r.vat_type || 'standard',
           category: r.category || '', kind: r.kind || '',
           ageMin: r.age_min, ageMax: r.age_max,
           sizes: safeArr(r.sizes), colours: safeArr(r.colours),
           wasPrice: r.was_price || null, image: r.image || '', images: safeArr(r.images),
           online: r.online == null ? 1 : r.online, featured: r.featured ? 1 : 0,
           dg: r.design_group || null, sizeLabel: r.size_label || null };
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
  if (t.includes('month')) {  // convert months to whole years for the website age filter
    if (nums.length >= 2) return { min: Math.floor(nums[0] / 12), max: Math.max(1, Math.ceil(nums[1] / 12)) };
    if (nums.length === 1) return { min: 0, max: Math.max(1, Math.ceil(nums[0] / 12)) };
    return { min: 0, max: 1 };
  }
  if (nums.length >= 2) return { min: nums[0], max: nums[1] };
  if (nums.length === 1) return { min: nums[0], max: nums[0] };
  return { min: 0, max: 10 };
}
function allProducts() {
  return db.prepare('SELECT * FROM products ORDER BY id').all().map(productOut);
}
function saleOut(s) {
  // join each line to its product cost so we can report the margin on the sale
  const lines = db.prepare(
    'SELECT sl.*, p.cost_price AS cost FROM sale_lines sl LEFT JOIN products p ON p.id = sl.product_id WHERE sl.sale_id = ?'
  ).all(s.id);
  const cogs = lines.reduce((t, l) => t + (l.cost || 0) * l.qty, 0);
  return {
    t: (s.datetime || '').slice(11, 16) || (s.datetime || ''),
    date: (s.datetime || '').slice(0, 10),
    ref: s.ref,
    cust: s.customer,
    method: METHOD_LABEL[s.method] || s.method,
    amt: s.total,
    vat: s.vat,
    profit: s.total - cogs,   // gross profit = what she paid minus what the stock cost
    mpesaRef: s.mpesa_ref || null,
    cashier: s.cashier,
    items: lines.map(l => [l.name, l.qty, l.unit_price]),
  };
}
function expenseOut(r) {
  return { id: r.id, desc: r.description || '', category: r.category || '', amount: r.amount || 0, on: r.spent_on || '', cashier: r.cashier || '' };
}
function allExpenses() {
  return db.prepare('SELECT * FROM expenses ORDER BY spent_on DESC, id DESC').all().map(expenseOut);
}
function addExpense(body) {
  const id = db.prepare(
    `INSERT INTO expenses (description, category, amount, spent_on, cashier, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(String(body.desc || '').trim() || 'Expense', String(body.category || '').trim() || 'General',
        Math.max(0, Math.round(Number(body.amount) || 0)),
        (body.on && String(body.on).slice(0, 10)) || now().slice(0, 10), body.cashier || null, now()).lastInsertRowid;
  return expenseOut(db.prepare('SELECT * FROM expenses WHERE id = ?').get(id));
}
function allSales() {
  return db.prepare('SELECT * FROM sales ORDER BY datetime DESC, id DESC').all().map(saleOut);
}
// --- till-close cash counts (the Z report's record) ---
function cashupOut(r) {
  return { id: r.id, at: r.at, range: r.for_range, cashier: r.cashier,
           opening: r.opening, cashSales: r.cash_sales, paidOut: r.paid_out,
           expected: r.expected, counted: r.counted, variance: r.variance };
}
function allCashups() {
  return db.prepare('SELECT * FROM cash_ups ORDER BY id DESC LIMIT 30').all().map(cashupOut);
}
// --- stock movement / audit trail (for the Stock report) ---
function allMovements(limit) {
  const n = Math.min(Math.max(Number(limit) || 200, 1), 2000);
  return db.prepare(
    `SELECT m.*, p.name AS pname FROM stock_movements m
     LEFT JOIN products p ON p.id = m.product_id
     ORDER BY m.id DESC LIMIT ?`
  ).all(n).map(r => ({
    id: r.id, product: r.pname || (r.product_id ? ('#' + r.product_id) : 'Unknown'),
    type: r.type, qty: r.qty, ref: r.ref, at: r.datetime, user: r.user || '',
  }));
}
function addCashup(body) {
  const opening = Math.max(0, Math.round(Number(body.opening) || 0));
  const cashSales = Math.max(0, Math.round(Number(body.cashSales) || 0));
  const paidOut = Math.max(0, Math.round(Number(body.paidOut) || 0));
  // Trust the client's expected only if given; otherwise recompute so the record is self-consistent.
  const expected = Number.isFinite(Number(body.expected)) ? Math.round(Number(body.expected)) : (opening + cashSales - paidOut);
  const counted = Math.max(0, Math.round(Number(body.counted) || 0));
  const variance = counted - expected;
  const id = db.prepare(
    `INSERT INTO cash_ups (at, for_range, cashier, opening, cash_sales, paid_out, expected, counted, variance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(localStamp(), String(body.range || 'Today'), body.cashier || null, opening, cashSales, paidOut, expected, counted, variance).lastInsertRowid;
  return cashupOut(db.prepare('SELECT * FROM cash_ups WHERE id = ?').get(id));
}
function heldOut(h) {
  return { id: h.id, type: h.type, cust: h.customer, deposit: h.deposit,
           lines: JSON.parse(h.lines || '[]'), at: h.at };
}
function allHeld() {
  return db.prepare('SELECT * FROM held_sales ORDER BY id DESC').all().map(heldOut);
}
// Staff list for the Settings screen — never includes passwords.
function allStaffPublic() {
  return db.prepare('SELECT id, name, username, role, color FROM staff ORDER BY id')
    .all().map(s => ({ id: s.id, name: s.name, username: s.username, role: s.role, c: s.color }));
}
function isOwnerPassword(pw) {
  const row = db.prepare("SELECT 1 FROM staff WHERE role = 'Owner' AND password = ? LIMIT 1").get(String(pw || ''));
  return !!row;
}
// --- login sessions: a token proves who is signed in, so owner actions need no re-typing ---
function createSession(username, role) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, username, role, created_at) VALUES (?, ?, ?, ?)').run(token, username, role, now());
  return token;
}
function sessionOf(req) {
  const token = req.headers['x-auth-token'];
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token = ?').get(String(token)) || null;
}
function isOwnerRequest(req) {
  const s = sessionOf(req);
  return !!(s && s.role === 'Owner');
}
// --- password hashing (scrypt, no npm) ---
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}
function verifyPassword(pw, stored) {
  stored = String(stored || '');
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    const salt = parts[1], hash = parts[2];
    if (!salt || !hash) return false;
    const calc = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    const a = Buffer.from(hash, 'hex'), b = Buffer.from(calc, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return stored === String(pw);   // legacy plaintext (upgraded on next successful login)
}
// --- server-side permissions: the same rights matrix the client uses, enforced for real ---
// roles: 0 Owner, 1 Manager, 2 Cashier, 3 Stock clerk, 4 Rider
const SRV_ROLES = ['Owner', 'Manager', 'Cashier', 'Stock clerk', 'Rider'];
const SRV_RIGHTS = [
  [1, 1, 1, 0, 0], // 0 sell / take payment
  [1, 1, 0, 0, 0], // 1 discount over 10%
  [1, 1, 0, 0, 0], // 2 cancel a sale / remove
  [1, 1, 0, 1, 0], // 3 accept a delivery
  [1, 1, 0, 0, 0], // 4 set price / manage products
  [1, 1, 0, 0, 0], // 5 approve a return
  [1, 1, 0, 0, 0], // 6 refund
  [1, 1, 0, 0, 0], // 7 see cost & profit / manager area (expenses, settings)
  [1, 1, 1, 0, 0], // 8 close the day
  [1, 0, 0, 0, 0], // 9 staff management (owner only)
];
function roleAllows(role, rightIndex) {
  const ri = SRV_ROLES.indexOf(role);
  return ri >= 0 && !!(SRV_RIGHTS[rightIndex] && SRV_RIGHTS[rightIndex][ri]);
}
function hasRight(req, rightIndex) {
  const s = sessionOf(req);
  return !!(s && roleAllows(s.role, rightIndex));
}
function orderOut(o) {
  return { id: o.id, ch: o.channel, cust: o.customer, area: o.area,
           items: JSON.parse(o.items || '[]'), amt: o.amount,
           pay: o.pay_status, st: o.fulfil_status, t: o.t };
}
function allOrders() {
  // TikTok Shop is hidden for now (channel 'tt'); WhatsApp only. Re-enable by dropping the filter.
  return db.prepare("SELECT * FROM orders WHERE channel != 'tt' ORDER BY id").all().map(orderOut);
}
function allReturns() {
  return db.prepare('SELECT * FROM returns ORDER BY id DESC').all().map(r =>
    ({ id: r.id, c: r.customer, item: r.item, why: r.reason, d: r.at, act: r.action, st: r.status, v: r.value, ref: r.sale_ref || null }));
}
// Put a returned item back on the shelf (best-effort match by product name).
function restockByName(name, user) {
  if (!name) return;
  const n = String(name).trim();
  let prod = db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE').get(n);
  if (!prod) { const base = n.split(',')[0].trim(); if (base && base !== n) prod = db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE').get(base); }
  if (!prod) return;
  db.prepare('UPDATE products SET stock_qty = stock_qty + 1 WHERE id = ?').run(prod.id);
  db.prepare(`INSERT INTO stock_movements (product_id, type, qty, ref, datetime, user) VALUES (?, 'return', 1, 'return to stock', ?, ?)`).run(prod.id, now(), user || null);
}
function addReturn(body) {
  const type = body.type === 'refund' ? 'refund' : 'swap';
  // swaps complete on the spot; refunds need a manager, so unapproved ones wait.
  const status = type === 'swap' ? 'done' : (body.approved ? 'done' : 'wait');
  const action = type === 'swap' ? 'Swapped' : (status === 'done' ? 'Refunded' : 'Refund pending');
  const value = type === 'refund' ? Math.max(0, Math.round(Number(body.value) || 0)) : 0;
  db.prepare(
    `INSERT INTO returns (customer, item, reason, at, action, status, value, sale_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(body.customer || 'Walk-in', body.item || '', body.reason || '', localStamp(), action, status, value, body.saleRef || null);
  // Refund = item back on the shelf, nothing taken → restock. Swap = even exchange → stock neutral.
  if (status === 'done' && type === 'refund') restockByName(body.item, body.cashier);
  return allReturns();
}
function decideReturn(id, body) {
  const r = db.prepare('SELECT * FROM returns WHERE id = ?').get(id);
  if (!r) return allReturns();
  if (body.action === 'swap') {
    db.prepare("UPDATE returns SET status='done', action='Swapped', value=0 WHERE id=?").run(id);
    // swap = even exchange, stock neutral
  } else {
    db.prepare("UPDATE returns SET status='done', action='Refunded' WHERE id=?").run(id);
    restockByName(r.item, body.cashier);  // refunded item back on the shelf
  }
  return allReturns();
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
    `INSERT INTO sales (ref, datetime, cashier, customer, subtotal, discount_pct, discount_amount, vat, total, method, split_parts, status, channel, mpesa_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)`
  ).run(ref, dt, body.cashier || null, body.customer || 'Walk-in', subtotal, discPct, discAmount, vat, total,
        method, body.splitParts ? JSON.stringify(body.splitParts) : null, body.channel || 'counter',
        body.mpesaRef ? String(body.mpesaRef).trim().toUpperCase() : null).lastInsertRowid;

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
    // when no explicit size, use the age range as the size chip (e.g. "6 to 24 months" -> "6-24m")
    const ageSize = (() => { const t = (r.age_range || '').toLowerCase(); if (!t || t.includes('all ages')) return null; const n = t.match(/\d+/g); if (!n) return null; const u = t.includes('month') ? 'm' : 'y'; return n.length >= 2 ? `${n[0]}-${n[1]}${u}` : `${n[0]}${u}`; })();
    const item = {
      sku: r.sku || ('IK-' + r.id),
      name: r.name,
      kind: r.kind || deriveKind(r.name),
      category: r.category || 'Other',
      ageMin: Number(ages.min) || 0,
      ageMax: Number(ages.max) || 0,
      price: r.selling_price || 0,
      stock: r.stock_qty || 0,
      sizes: sizes.length ? sizes : (ageSize ? [ageSize] : ['One size']),
      colours: colours.length ? colours : ['teal'],
      tags: r.featured ? ['featured'] : [],
      image: r.image || '',
      images: (() => { const g = safeArr(r.images); return g.length ? g : (r.image ? [r.image] : []); })(),
      dg: r.design_group || null,          // shared design id — sizes of one series share it
      sizeLabel: r.size_label || null,     // this item's size within the series (e.g. an age)
    };
    if (r.was_price && r.was_price > r.selling_price) item.wasPrice = r.was_price;
    return item;
  });
}

function addProduct(body) {
  // a temporary sku; if the caller gave none we replace it with a tidy ILK-##### based on the new id
  const sku = (body.sku && String(body.sku).trim()) || null;
  const vatType = body.vat_type === 'exempt' ? 'exempt' : 'standard';
  const ages = deriveAges(body.a);
  const kind = (body.kind && String(body.kind).trim()) || deriveKind(body.n);
  const sizes = Array.isArray(body.sizes) ? body.sizes : [];
  const colours = Array.isArray(body.colours) ? body.colours : [];
  const images = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
  const mainImage = body.image || images[0] || null;
  const id = db.prepare(
    `INSERT INTO products (name, age_range, category, cost_price, selling_price, wholesale_price, stock_qty, sku, barcode, received, created_at, vat_type,
       kind, age_min, age_max, sizes, colours, was_price, image, images, online, featured)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'today', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(body.n, body.a || 'All ages', body.category || null, Number(body.c) || 0, Number(body.p) || 0, Number(body.w) || 0, Number(body.s) || 0,
        sku, null, now(), vatType,
        kind, ages.min, ages.max, JSON.stringify(sizes), JSON.stringify(colours),
        Number(body.was_price) || null, mainImage, JSON.stringify(images),
        body.online === false || body.online === 0 ? 0 : 1, body.featured ? 1 : 0).lastInsertRowid;
  // give it a barcode in the prototype's style, and a tidy auto SKU if none was supplied
  const bc = '629' + String(1041500 + (id * 137)).slice(-7);
  const finalSku = sku || ('ILK-' + String(id).padStart(5, '0'));
  db.prepare('UPDATE products SET barcode = ?, sku = ? WHERE id = ?').run(bc, finalSku, id);
  if (Number(body.s) > 0) {
    db.prepare(`INSERT INTO stock_movements (product_id, type, qty, ref, datetime, user) VALUES (?, 'adjust', ?, 'opening', ?, ?)`)
      .run(id, Number(body.s), now(), body.cashier || null);
  }
  return productOut(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
}

// Turn a size label ("6-18m", "3y", "0-3m") into a readable age range for the website age filter.
function seriesAgeRange(label) {
  const s = String(label || '').trim();
  let m = s.match(/^(\d+)\s*-\s*(\d+)\s*m/i); if (m) return m[1] + ' to ' + m[2] + ' months';
  m = s.match(/^(\d+)\s*m/i); if (m) return m[1] + ' months';
  m = s.match(/^(\d+)\s*-\s*(\d+)\s*y/i); if (m) return m[1] + ' to ' + m[2] + ' years';
  m = s.match(/^(\d+)\s*y?$/i); if (m) return m[1] + ' years';
  return s;
}
// Create a size series: one design, several sizes (ages), each its own stock item + barcode,
// all sharing a design_group so the website can group them into one product with a size picker.
function addSeries(body) { return transaction(() => {
  const dg = 'DG-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const sizes = Array.isArray(body.sizes)
    ? body.sizes.filter(s => s && s.age !== undefined && s.age !== null && String(s.age).trim() !== '')
    : [];
  const setGroup = db.prepare('UPDATE products SET design_group = ?, size_label = ? WHERE id = ?');
  const ids = [];
  sizes.forEach(s => {
    const age = String(s.age).trim();
    const prod = addProduct({
      n: body.n, a: seriesAgeRange(age), category: body.category,
      c: body.c, p: body.p, w: body.w,
      s: Math.max(0, Math.round(Number(s.stock) || 0)),
      vat_type: body.vat_type, sizes: [age], colours: body.colours,
      image: body.image, images: body.images,
      online: (body.online === false || body.online === 0) ? 0 : 1, featured: body.featured, cashier: body.cashier,
    });
    setGroup.run(dg, age, prod.id);
    ids.push(prod.id);
  });
  return { dg, count: ids.length, products: allProducts() };
}); }

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
    req.on('data', c => { data += c; if (data.length > 8e6) req.destroy(); });
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
        staff: allStaffPublic(),
        intake: del.intake,
        delivery: del.delivery,
        expenses: allExpenses(),
        cashups: allCashups(),
        aiTitles: aiEnabled(),
        bgRemoval: bgEnabled(),
        aiModel: (aiConfig() || {}).model || 'claude-haiku-4-5',
      });
    }

    // Owner saves (or clears) the API keys: Anthropic (naming) and remove.bg (background).
    if (p === '/api/ai-config' && method === 'POST') {
      if (!isOwnerRequest(req)) return sendJSON(res, 403, { error: 'Only the owner can set this up' });
      const body = await readBody(req);
      const cfg = aiConfig() || {};
      if (body.clear) delete cfg.key;
      if (body.clearRemovebg) delete cfg.removebg_key;
      if (typeof body.key === 'string' && body.key.trim()) {
        if (body.key.trim().length < 10) return sendJSON(res, 400, { error: 'That does not look like a valid API key' });
        cfg.key = body.key.trim();
      }
      if (typeof body.model === 'string' && body.model.trim()) cfg.model = body.model.trim();
      if (typeof body.removebg_key === 'string' && body.removebg_key.trim()) {
        if (body.removebg_key.trim().length < 10) return sendJSON(res, 400, { error: 'That does not look like a valid remove.bg key' });
        cfg.removebg_key = body.removebg_key.trim();
      }
      if (!cfg.key && !cfg.removebg_key) { try { fs.unlinkSync(aiConfigPath()); } catch (e) {} }
      else { fs.writeFileSync(aiConfigPath(), JSON.stringify(cfg, null, 2)); try { fs.chmodSync(aiConfigPath(), 0o600); } catch (e) {} }
      return sendJSON(res, 200, { aiTitles: !!cfg.key, bgRemoval: !!cfg.removebg_key, model: cfg.model || 'claude-haiku-4-5' });
    }

    // Upload a photo with its background removed (via remove.bg). Returns the saved URL.
    if (p === '/api/upload-nobg' && method === 'POST') {
      if (!hasRight(req, 4)) return sendJSON(res, 403, { error: "Only a manager can add product photos" });
      const cfg = aiConfig();
      if (!cfg || !cfg.removebg_key) return sendJSON(res, 200, { ok: false, error: 'Background removal is not set up yet' });
      const body = await readBody(req);
      const m = String(body.data || '').match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
      if (!m) return sendJSON(res, 200, { ok: false, error: 'Not a valid image' });
      try {
        const png = await removeBgViaService({ b64: m[2], key: cfg.removebg_key });
        const name = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.png';
        fs.writeFileSync(path.join(UPLOAD_DIR, name), png);
        return sendJSON(res, 200, { ok: true, url: '//' + (req.headers.host || 'localhost') + '/uploads/' + name });
      } catch (err) {
        return sendJSON(res, 200, { ok: false, error: String((err && err.message) || err).slice(0, 200) });
      }
    }

    // Suggest a product title from an outfit photo (AI vision). Returns { ok, title } or { ok:false, error }.
    if (p === '/api/suggest-title' && method === 'POST') {
      if (!hasRight(req, 4)) return sendJSON(res, 403, { error: "Only a manager can name products" });
      const cfg = aiConfig();
      if (!cfg || !cfg.key) return sendJSON(res, 200, { ok: false, notConfigured: true, error: 'AI naming is not set up yet' });
      const body = await readBody(req);
      let base64, mediaType;
      if (body.imageFile) {
        const name = path.basename(String(body.imageFile));
        const file = path.join(UPLOAD_DIR, name);
        if (!name || !fs.existsSync(file)) return sendJSON(res, 200, { ok: false, error: 'Could not find that photo on the server' });
        const buf = fs.readFileSync(file);
        mediaType = sniffImageType(buf) || EXT_MIME[(name.split('.').pop() || '').toLowerCase()] || 'image/jpeg';
        base64 = buf.toString('base64');
      } else if (body.image) {
        const m = String(body.image).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
        if (!m) return sendJSON(res, 200, { ok: false, error: 'Not a valid image' });
        mediaType = m[1].toLowerCase(); base64 = m[2];
      } else {
        return sendJSON(res, 200, { ok: false, error: 'No photo to read' });
      }
      try {
        const title = cleanTitle(await suggestTitleFromImage({ base64, mediaType, category: body.category, cfg }));
        if (!title) return sendJSON(res, 200, { ok: false, error: 'The AI did not return a name' });
        return sendJSON(res, 200, { ok: true, title });
      } catch (err) {
        return sendJSON(res, 200, { ok: false, error: String((err && err.message) || err).slice(0, 200) });
      }
    }

    // Stock movement / audit trail for the Stock report (?limit=NNN, newest first).
    if (p === '/api/movements' && method === 'GET') {
      return sendJSON(res, 200, { movements: allMovements(url.searchParams.get('limit')) });
    }

    // Record an end-of-day cash count (the Z report). Returns the saved count + recent history.
    if (p === '/api/cashup' && method === 'POST') {
      if (!hasRight(req, 8)) return sendJSON(res, 403, { error: "You are not allowed to close the day" });
      const body = await readBody(req);
      return sendJSON(res, 200, { cashup: addCashup(body), cashups: allCashups() });
    }

    // Upload a product photo (sent as a data URL). Saves a file and returns its URL.
    if (p === '/api/upload' && method === 'POST') {
      if (!hasRight(req, 4)) return sendJSON(res, 403, { error: "Only a manager can add product photos" });
      const body = await readBody(req);
      const m = String(body.data || '').match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
      if (!m) return sendJSON(res, 400, { error: 'Not a valid image' });
      const ext = MIME_EXT[m[1].toLowerCase()];
      if (!ext) return sendJSON(res, 400, { error: 'Unsupported image type' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 6e6) return sendJSON(res, 400, { error: 'Image is too large' });
      const name = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      // protocol-relative URL so it works on the POS and the shop website (both https in production)
      return sendJSON(res, 200, { url: '//' + (req.headers.host || 'localhost') + '/uploads/' + name });
    }

    // Returns and swaps.
    if (p === '/api/returns' && method === 'POST') {
      if (!hasRight(req, 0)) return sendJSON(res, 403, { error: "You are not allowed to record returns" });
      const body = await readBody(req);
      return sendJSON(res, 200, { returns: addReturn(body), products: allProducts() });
    }
    const retDecide = p.match(/^\/api\/returns\/(\d+)$/);
    if (retDecide && method === 'PATCH') {
      if (!hasRight(req, 5)) return sendJSON(res, 403, { error: "Only a manager can approve or change a return" });
      const body = await readBody(req);
      return sendJSON(res, 200, { returns: decideReturn(Number(retDecide[1]), body), products: allProducts() });
    }

    // Expenses (shop running costs). Recording gated on the client to owner/manager.
    if (p === '/api/expenses' && method === 'POST') {
      if (!hasRight(req, 7)) return sendJSON(res, 403, { error: "Only a manager can record expenses" });
      const body = await readBody(req);
      return sendJSON(res, 200, { expense: addExpense(body) });
    }
    const expDel = p.match(/^\/api\/expenses\/(\d+)$/);
    if (expDel && method === 'DELETE') {
      if (!hasRight(req, 7)) return sendJSON(res, 403, { error: "Only a manager can remove an expense" });
      db.prepare('DELETE FROM expenses WHERE id = ?').run(Number(expDel[1]));
      return sendJSON(res, 200, { ok: true });
    }

    // Change your own password (needs your current one).
    if (p === '/api/password' && method === 'POST') {
      const body = await readBody(req);
      const uname = String(body.username || '').trim().toLowerCase();
      const cur = String(body.currentPassword || '');
      const next = String(body.newPassword || '');
      if (next.length < 4) return sendJSON(res, 400, { error: 'New password must be at least 4 characters' });
      const row = db.prepare('SELECT * FROM staff WHERE lower(username) = ?').get(uname);
      if (!row || !verifyPassword(cur, row.password)) return sendJSON(res, 401, { error: 'Your current password is wrong' });
      db.prepare('UPDATE staff SET password = ? WHERE id = ?').run(hashPassword(next), row.id);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      const uname = String(body.username || '').trim().toLowerCase();
      const pw = String(body.password || '');
      const row = db.prepare('SELECT * FROM staff WHERE lower(username) = ?').get(uname);
      if (!row || !verifyPassword(pw, row.password)) return sendJSON(res, 401, { error: 'Wrong username or password' });
      // Lazily upgrade any legacy plaintext password to a hash on successful login.
      if (!String(row.password).startsWith('scrypt$')) db.prepare('UPDATE staff SET password = ? WHERE id = ?').run(hashPassword(pw), row.id);
      const token = createSession(row.username, row.role);
      return sendJSON(res, 200, { user: { name: row.name, role: row.role, c: row.color, username: row.username }, token });
    }

    if (p === '/api/logout' && method === 'POST') {
      const token = req.headers['x-auth-token'];
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
      return sendJSON(res, 200, { ok: true });
    }

    // Owner "forgot password": email a reset link. Always responds generically (no user enumeration).
    if (p === '/api/forgot' && method === 'POST') {
      const body = await readBody(req);
      const uname = String(body.username || '').trim().toLowerCase();
      const owner = db.prepare("SELECT * FROM staff WHERE lower(username) = ? AND role = 'Owner'").get(uname);
      const cfg = mailConfig();
      if (owner && cfg && cfg.key && cfg.to) {
        const token = crypto.randomBytes(24).toString('hex');
        const expires = new Date(Date.now() + 30 * 60000).toISOString();
        db.prepare('DELETE FROM resets WHERE username = ?').run(owner.username);
        db.prepare('INSERT INTO resets (token, username, expires_at) VALUES (?, ?, ?)').run(token, owner.username, expires);
        const link = `https://${req.headers.host}/?reset=${token}`;
        try {
          await sendMail({ key: cfg.key, from: cfg.from, to: cfg.to,
            subject: 'Reset your ilekela POS password',
            text: `A password reset was requested for the owner login "${owner.username}".\n\nOpen this link within 30 minutes to set a new password:\n${link}\n\nIf you did not request this, ignore this email and your password stays the same.` });
        } catch (err) { console.error('reset email failed:', (err && (err.message || err.code)) || err); }
      }
      return sendJSON(res, 200, { ok: true });
    }

    // Complete a reset with the emailed token.
    if (p === '/api/reset' && method === 'POST') {
      const body = await readBody(req);
      const token = String(body.token || '');
      const next = String(body.newPassword || '');
      if (next.length < 4) return sendJSON(res, 400, { error: 'New password must be at least 4 characters' });
      const row = db.prepare('SELECT * FROM resets WHERE token = ?').get(token);
      if (!row || new Date(row.expires_at) < new Date()) return sendJSON(res, 400, { error: 'This reset link has expired or is invalid. Request a new one.' });
      db.prepare('UPDATE staff SET password = ? WHERE lower(username) = ?').run(hashPassword(next), row.username.toLowerCase());
      db.prepare('DELETE FROM resets WHERE username = ?').run(row.username);
      db.prepare('DELETE FROM sessions WHERE username = ?').run(row.username);  // log out old sessions
      return sendJSON(res, 200, { ok: true, username: row.username });
    }

    if (p === '/api/sales' && method === 'POST') {
      if (!hasRight(req, 0)) return sendJSON(res, 403, { error: "You are not allowed to take payment" });
      const body = await readBody(req);
      return sendJSON(res, 200, recordSale(body));
    }

    if (p === '/api/products' && method === 'POST') {
      if (!hasRight(req, 4)) return sendJSON(res, 403, { error: "Only a manager can add products" });
      const body = await readBody(req);
      if (!body.n || !String(body.n).trim()) return sendJSON(res, 400, { error: 'name required' });
      return sendJSON(res, 200, { product: addProduct(body) });
    }

    // Add a size series: one design, several sizes (ages), each its own stock item.
    if (p === '/api/products/series' && method === 'POST') {
      if (!hasRight(req, 4)) return sendJSON(res, 403, { error: "Only a manager can add products" });
      const body = await readBody(req);
      if (!body.n || !String(body.n).trim()) return sendJSON(res, 400, { error: 'name required' });
      if (!Array.isArray(body.sizes) || !body.sizes.length) return sendJSON(res, 400, { error: 'add at least one size' });
      return sendJSON(res, 200, addSeries(body));
    }

    // Save shop settings (whitelisted so unknown keys are ignored).
    if (p === '/api/settings' && method === 'PATCH') {
      if (!hasRight(req, 7)) return sendJSON(res, 403, { error: "Only a manager can change settings" });
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
      // Opening float (cash left in the drawer to start the day) — whole shillings.
      if (body.opening_float !== undefined) {
        const f = Math.round(Number(body.opening_float));
        if (!Number.isFinite(f) || f < 0) return sendJSON(res, 400, { error: 'Opening float must be a whole number of shillings, 0 or more' });
        setSetting('opening_float', f);
      }
      // Free-value settings (printer calibration, etc.) stored as strings.
      ['receipt_width', 'receipt_text', 'label_size'].forEach(k => {
        if (body[k] !== undefined) setSetting(k, String(body[k]));
      });
      return sendJSON(res, 200, { shop: settingsOut() });
    }

    // Public shop catalogue — preview, live file, and publish.
    if (p === '/api/catalogue.json' && method === 'GET') {
      return sendJSON(res, 200, buildCatalogue());
    }
    if (p === '/products.json' && method === 'GET') {
      // Always-live catalogue for the shop website. CORS open so the site can read it from any host.
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(JSON.stringify(buildCatalogue()));
    }
    if (p === '/api/catalogue/publish' && method === 'POST') {
      if (!hasRight(req, 7)) return sendJSON(res, 403, { error: "Only a manager can publish the catalogue" });
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

    // Owner adds a new staff member (confirmed with the owner's own password).
    if (p === '/api/staff' && method === 'POST') {
      if (!isOwnerRequest(req)) return sendJSON(res, 403, { error: 'Only the owner can add staff' });
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const username = String(body.username || '').trim().toLowerCase();
      const role = String(body.role || '').trim();
      const password = String(body.password || '');
      if (!name || !username || !role) return sendJSON(res, 400, { error: 'Name, username and role are required' });
      if (password.length < 4) return sendJSON(res, 400, { error: 'Password must be at least 4 characters' });
      if (db.prepare('SELECT 1 FROM staff WHERE lower(username) = ?').get(username)) return sendJSON(res, 400, { error: 'That username is already taken' });
      db.prepare('INSERT INTO staff (name, username, role, password, color) VALUES (?, ?, ?, ?, ?)')
        .run(name, username, role, hashPassword(password), body.color || '#ec7060');
      return sendJSON(res, 200, { staff: allStaffPublic(), added: name });
    }

    let m;
    // Owner removes a staff member (confirmed with the owner's own password).
    if ((m = p.match(/^\/api\/staff\/(\d+)$/)) && method === 'DELETE') {
      if (!isOwnerRequest(req)) return sendJSON(res, 403, { error: 'Only the owner can remove staff' });
      const target = db.prepare('SELECT * FROM staff WHERE id = ?').get(Number(m[1]));
      if (!target) return sendJSON(res, 404, { error: 'no such staff member' });
      if (target.role === 'Owner' && db.prepare("SELECT COUNT(*) AS c FROM staff WHERE role = 'Owner'").get().c <= 1) {
        return sendJSON(res, 400, { error: 'You cannot remove the only owner' });
      }
      db.prepare('DELETE FROM staff WHERE id = ?').run(target.id);
      return sendJSON(res, 200, { staff: allStaffPublic(), removed: target.name });
    }
    // Owner resets a staff member's password (confirmed with the owner's own password).
    if ((m = p.match(/^\/api\/staff\/(\d+)\/password$/)) && method === 'POST') {
      if (!isOwnerRequest(req)) return sendJSON(res, 403, { error: 'Only the owner can set staff passwords' });
      const body = await readBody(req);
      const next = String(body.newPassword || '');
      if (next.length < 4) return sendJSON(res, 400, { error: 'New password must be at least 4 characters' });
      const target = db.prepare('SELECT * FROM staff WHERE id = ?').get(Number(m[1]));
      if (!target) return sendJSON(res, 404, { error: 'no such staff member' });
      db.prepare('UPDATE staff SET password = ? WHERE id = ?').run(hashPassword(next), target.id);
      return sendJSON(res, 200, { ok: true, name: target.name });
    }

    // Update a product: VAT status, website catalogue fields, online/featured flags.
    if ((m = p.match(/^\/api\/products\/(\d+)$/)) && method === 'PATCH') {
      if (!hasRight(req, 4)) return sendJSON(res, 403, { error: 'Only a manager can change a product' });
      const body = await readBody(req);
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(m[1]));
      if (!prod) return sendJSON(res, 404, { error: 'no such product' });
      const set = (col, val) => db.prepare(`UPDATE products SET ${col} = ? WHERE id = ?`).run(val, prod.id);
      if (body.vat_type !== undefined) set('vat_type', body.vat_type === 'exempt' ? 'exempt' : 'standard');
      if (body.p !== undefined) set('selling_price', Number(body.p) || 0);
      if (body.c !== undefined) set('cost_price', Number(body.c) || 0);
      if (body.w !== undefined) set('wholesale_price', Number(body.w) || 0);
      if (body.category !== undefined) set('category', body.category || null);
      if (body.kind !== undefined) set('kind', body.kind || null);
      if (body.sizes !== undefined) set('sizes', JSON.stringify(Array.isArray(body.sizes) ? body.sizes : []));
      if (body.colours !== undefined) set('colours', JSON.stringify(Array.isArray(body.colours) ? body.colours : []));
      if (body.was_price !== undefined) set('was_price', Number(body.was_price) || null);
      if (body.image !== undefined) set('image', body.image || null);
      if (body.images !== undefined) { const arr = Array.isArray(body.images) ? body.images.filter(Boolean) : []; set('images', JSON.stringify(arr)); set('image', arr[0] || null); }
      if (body.online !== undefined) set('online', (body.online === true || body.online === 1 || body.online === '1') ? 1 : 0);
      if (body.featured !== undefined) set('featured', (body.featured === true || body.featured === 1 || body.featured === '1') ? 1 : 0);
      return sendJSON(res, 200, { product: productOut(db.prepare('SELECT * FROM products WHERE id = ?').get(prod.id)) });
    }
    if ((m = p.match(/^\/api\/deliveries\/(\d+)\/accept$/)) && method === 'POST') {
      if (!hasRight(req, 3)) return sendJSON(res, 403, { error: 'You are not allowed to accept a delivery' });
      const result = acceptDelivery(Number(m[1]));
      if (!result) return sendJSON(res, 404, { error: 'no pending delivery' });
      return sendJSON(res, 200, result);
    }

    if (p === '/api/held' && method === 'POST') {
      if (!hasRight(req, 0)) return sendJSON(res, 403, { error: "You are not allowed to hold a sale" });
      const body = await readBody(req);
      return sendJSON(res, 200, { held: addHeld(body) });
    }
    if ((m = p.match(/^\/api\/held\/(\d+)$/)) && method === 'DELETE') {
      if (!hasRight(req, 0)) return sendJSON(res, 403, { error: 'You are not allowed to drop a held sale' });
      db.prepare('DELETE FROM held_sales WHERE id = ?').run(Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }

    if ((m = p.match(/^\/api\/orders\/(\d+)$/)) && method === 'PATCH') {
      if (!hasRight(req, 0)) return sendJSON(res, 403, { error: 'You are not allowed to update orders' });
      const body = await readBody(req);
      const o = advanceOrder(Number(m[1]), body.st);
      if (!o) return sendJSON(res, 404, { error: 'no such order' });
      return sendJSON(res, 200, { order: o });
    }
    if ((m = p.match(/^\/api\/orders\/(\d+)$/)) && method === 'DELETE') {
      if (!hasRight(req, 2)) return sendJSON(res, 403, { error: 'Only a manager can remove an order' });
      db.prepare('DELETE FROM orders WHERE id = ?').run(Number(m[1]));
      return sendJSON(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) return sendJSON(res, 404, { error: 'not found' });

    // ---- static: uploaded product photos ----
    if (p.startsWith('/uploads/') && method === 'GET') {
      const name = path.basename(decodeURIComponent(p.slice('/uploads/'.length)));  // basename blocks path traversal
      const file = path.join(UPLOAD_DIR, name);
      if (!name || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
      const ext = (name.split('.').pop() || '').toLowerCase();
      res.writeHead(200, { 'Content-Type': EXT_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000', 'Access-Control-Allow-Origin': '*' });
      return res.end(fs.readFileSync(file));
    }

    // ---- static: the prototype HTML ----
    if ((p === '/' || p === '/index.html' || p === '/babyshop-pos-friendly.html') && method === 'GET') {
      const html = fs.readFileSync(HTML_FILE);
      // Never cache the page, so every load runs the latest version after a deploy (no hard-refresh needed).
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
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
