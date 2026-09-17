// ============================================================
//  Ilekela POS - local print agent
//
//  Runs on the shop PC/tablet, next to the printer. The POS page (in the
//  browser) posts print jobs here so receipts and labels go STRAIGHT to the
//  printer with no browser print dialog and no guesswork.
//
//  It forwards raw ESC/POS bytes to a named Windows printer in RAW mode via
//  the print spooler (P/Invoke through a short PowerShell snippet). No drivers,
//  no npm packages.
//
//  Run:   node print-agent.js       (Windows, Node 18+)
//  Keep the window open while the shop is trading. To start it automatically,
//  see START-PRINT-AGENT.md.
//
//  Then in the POS: Settings > Printers and devices > turn on "Direct printing",
//  pick the printer names, and print a test receipt.
// ============================================================
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PRINT_AGENT_PORT) || 9110;

// Optional print-agent.config.json next to this file:
//   { "receiptPrinter": "POS-80", "labelPrinter": "Label-40" }
function cfg() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'print-agent.config.json'), 'utf8')); }
  catch (e) { return {}; }
}

// Send raw bytes to a Windows printer by name, in RAW mode.
function rawPrint(printerName, buf) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'ilk-print-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.bin');
    fs.writeFileSync(tmp, buf);
    const ps = `
$ErrorActionPreference='Stop'
$code=@"
using System;using System.IO;using System.Runtime.InteropServices;
public class RP{
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct DI{[MarshalAs(UnmanagedType.LPWStr)]public string n;[MarshalAs(UnmanagedType.LPWStr)]public string o;[MarshalAs(UnmanagedType.LPWStr)]public string t;}
 [DllImport("winspool.Drv",EntryPoint="OpenPrinterW",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool OpenPrinter(string s,out IntPtr h,IntPtr d);
 [DllImport("winspool.Drv",EntryPoint="ClosePrinter",SetLastError=true)] static extern bool ClosePrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="StartDocPrinterW",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool StartDocPrinter(IntPtr h,int l,ref DI di);
 [DllImport("winspool.Drv",EntryPoint="EndDocPrinter",SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="StartPagePrinter",SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="EndPagePrinter",SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="WritePrinter",SetLastError=true)] static extern bool WritePrinter(IntPtr h,byte[] b,int c,out int w);
 public static void Send(string printer,string file){ byte[] bytes=File.ReadAllBytes(file); IntPtr h; if(!OpenPrinter(printer,out h,IntPtr.Zero)) throw new Exception("Cannot open printer: "+printer); DI di=new DI(); di.n="ilekela"; di.t="RAW"; StartDocPrinter(h,1,ref di); StartPagePrinter(h); int w; WritePrinter(h,bytes,bytes.Length,out w); EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h); }
}
"@
Add-Type -TypeDefinition $code -Language CSharp
[RP]::Send(${JSON.stringify(printerName)}, ${JSON.stringify(tmp)})
`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, (err, so, se) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (err) {
        const raw = String(se || err.message || 'print failed');
        const nice = (raw.match(/Cannot open printer:[^"\r\n]*/) || [])[0] || raw.split(/\r?\n/).find(l => l.trim()) || 'print failed';
        reject(new Error(nice.trim().slice(0, 200)));
      } else resolve(true);
    });
  });
}

// List installed printers (for the setup / health check).
function listPrinters() {
  return new Promise(res => {
    execFile('powershell.exe', ['-NoProfile', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'],
      { windowsHide: true }, (e, so) => res(e ? [] : String(so).split(/\r?\n/).map(x => x.trim()).filter(Boolean)));
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health' && req.method === 'GET') {
    const printers = await listPrinters();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, agent: 'ilekela-print', version: 1, printers, config: cfg() }));
  }

  if (url.pathname === '/print' && req.method === 'POST') {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const b = JSON.parse(data || '{}');
        const c = cfg();
        const kind = b.kind === 'label' ? 'label' : 'receipt';
        const printer = b.printer || (kind === 'label' ? c.labelPrinter : c.receiptPrinter) || c.receiptPrinter;
        if (!printer) return sendJSON(res, { ok: false, error: 'No printer chosen for a ' + kind });
        const buf = Buffer.from(String(b.dataB64 || ''), 'base64');
        if (!buf.length) return sendJSON(res, { ok: false, error: 'Nothing to print' });
        await rawPrint(printer, buf);
        console.log(new Date().toLocaleTimeString(), 'printed', kind, '->', printer, '(' + buf.length + ' bytes)');
        sendJSON(res, { ok: true, printer });
      } catch (err) {
        console.error('print error:', err && err.message);
        sendJSON(res, { ok: false, error: String((err && err.message) || err).slice(0, 300) });
      }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});
function sendJSON(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

server.listen(PORT, '127.0.0.1', () => {
  console.log('Ilekela print agent listening on http://localhost:' + PORT);
  console.log('Keep this window open while the shop is trading.');
  listPrinters().then(p => console.log('Printers found on this PC:', p.length ? p.join(', ') : '(none detected)'));
});
