// ============================================================
//  import-stock.js  -  one-off importer for the real shop stock.
//  Reads stock-import.json (parsed from the ROBISEARCH stock report)
//  and REPLACES the demo products + demo sales history with it.
//
//  Run on the server, from /var/www/babypos, AFTER a backup:
//      node import-stock.js --replace
//  Without --replace it only shows what it would do (dry run).
// ============================================================
const fs = require('node:fs');
const path = require('node:path');
const { db, now, transaction } = require('./db');

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'stock-import.json'), 'utf8'));
const doIt = process.argv.includes('--replace');

const before = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
const totalStock = rows.reduce((t, r) => t + (Number(r.qty) || 0), 0);
const stockValue = rows.reduce((t, r) => t + (Number(r.qty) || 0) * (Number(r.sell) || 0), 0);
const cats = {};
rows.forEach(r => cats[r.category] = (cats[r.category] || 0) + 1);

console.log('Products currently in the system:', before);
console.log('Rows to import:', rows.length, '| total units:', totalStock, '| stock value (sell): KSh', stockValue.toLocaleString());
console.log('Categories:');
Object.entries(cats).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log('  ' + String(n).padStart(3), c));

if (!doIt) {
  console.log('\nDRY RUN. Nothing changed. Re-run with  node import-stock.js --replace  to apply.');
  process.exit(0);
}

// Tables cleared so reports start clean (staff, settings, sessions, resets are kept).
const WIPE = ['sale_lines', 'sales', 'stock_movements', 'delivery_lines', 'deliveries', 'held_sales', 'orders', 'returns', 'products'];

const insProd = db.prepare(
  `INSERT INTO products (name, age_range, category, cost_price, selling_price, wholesale_price, stock_qty, sku, barcode, received, created_at, vat_type, online, featured)
   VALUES (?, 'All ages', ?, ?, ?, ?, ?, ?, ?, 'imported', ?, 'standard', 1, 0)`);
const setBc = db.prepare('UPDATE products SET barcode = ? WHERE id = ?');
const insMove = db.prepare(`INSERT INTO stock_movements (product_id, type, qty, ref, datetime, user) VALUES (?, 'adjust', ?, 'opening stock', ?, 'import')`);

let n = 0;
transaction(() => {
  for (const t of WIPE) db.prepare(`DELETE FROM ${t}`).run();
  for (const r of rows) {
    const id = insProd.run(r.name, r.category, Number(r.cost) || 0, Number(r.sell) || 0, Number(r.wholesale) || 0, Number(r.qty) || 0, String(r.code), now()).lastInsertRowid;
    setBc.run('629' + String(1041500 + (id * 137)).slice(-7), id);
    if (Number(r.qty) > 0) insMove.run(id, Number(r.qty), now());
    n++;
  }
});

const after = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
console.log(`\nDone. Imported ${n} products. Products now in the system: ${after}.`);
console.log('Demo sales/deliveries/orders were cleared so your reports start fresh.');
