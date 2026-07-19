// Render a fixed-canvas HTML to a high-res PNG via Playwright.
// Usage: node render_html.js <input.html> <output.png> <width> <height>
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const input = process.argv[2];
const output = process.argv[3];
const W = parseInt(process.argv[4] || "1720", 10);
const H = parseInt(process.argv[5] || "1340", 10);
const SCALE = 2;

if (!input || !output) {
  console.error("Usage: node render_html.js <input.html> <output.png> <width> <height>");
  process.exit(2);
}

const htmlPath = path.resolve(input);
const outPath = path.resolve(output);
const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/");

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: SCALE,
  });
  const page = await context.newPage();
  await page.goto(fileUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);

  // Prefer a .canvas element; fall back to full page.
  const el = await page.$(".canvas");
  if (el) {
    await el.screenshot({ path: outPath });
  } else {
    await page.screenshot({ path: outPath, fullPage: true });
  }
  await browser.close();

  const size = fs.statSync(outPath).size;
  console.log(`OK  ${path.basename(outPath)}`);
  console.log(`    ${W * SCALE} x ${H * SCALE} px (${(size / 1024).toFixed(0)} KB)`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
