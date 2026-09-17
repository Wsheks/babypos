# Ilekela print agent - setup (one time)

The print agent lets the till print receipts and labels **straight to the printer**,
with no browser print box. It runs on the **shop PC** that has the printers.

## What you need
- The shop PC running **Windows** with **Node.js** installed (the same as the POS server needs).
- Your thermal **receipt printer** and **label printer** installed in Windows (they show under Settings > Printers & scanners).

## Set it up
1. Put `print-agent.js` and `START-PRINT-AGENT.bat` in a folder on the shop PC
   (or download them from the till: open `https://ilekelapos.ddns.net/print-agent.js`
   and `https://ilekelapos.ddns.net/print-agent.bat`, save both into one folder).
2. Double-click **START-PRINT-AGENT.bat**. A window opens and lists the printers it can see.
   Leave this window open while the shop is trading.
3. In the POS: **Settings > Printers and devices > Direct printing**:
   - Tap **Check the agent** - it should say "Agent is on" and list your printers.
   - Type the **exact** receipt printer name and label printer name (copy them from the list).
   - Turn on **Print straight to the printer**.
   - Tap **Print a test receipt**.

That's it. If the agent window is closed, printing simply falls back to the browser print box, so nothing breaks.

## Start it automatically (optional)
To have it start with Windows, press `Win + R`, type `shell:startup`, and put a shortcut
to `START-PRINT-AGENT.bat` in that folder.

## Notes
- The agent only listens on this PC (localhost), so it is not reachable from the internet.
- Receipts print as ESC/POS text (works on standard 58mm/80mm thermal receipt printers).
- Label printing is ready to test; if your label printer speaks a different language, tell us and we will tune it.
