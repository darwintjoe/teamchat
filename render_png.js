// Render teamchat_infographic.html to a high-res PNG via Playwright.
// Usage:  node render_png.js
const path = require("path");
const { chromium } = require("playwright");

const CANVAS_W = 1600;
const CANVAS_H = 1100;
const SCALE = 2; // 2x for ~300dpi print quality

(async () => {
  const htmlPath = path.resolve(__dirname, "teamchat_infographic.html");
  const outPath = path.resolve(__dirname, "teamchat_infographic.png");
  const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/");

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: CANVAS_W, height: CANVAS_H },
    deviceScaleFactor: SCALE,
  });
  const page = await context.newPage();

  await page.goto(fileUrl, { waitUntil: "networkidle" });
  // Ensure web fonts (Inter) are fully loaded before screenshot.
  await page.evaluate(() => document.fonts.ready);
  // Small extra settle for emoji glyph rasterisation.
  await page.waitForTimeout(400);

  // Screenshot exactly the .canvas element (the infographic itself,
  // excluding any surrounding page background).
  const el = await page.$(".canvas");
  await el.screenshot({ path: outPath, omitBackground: false });

  await browser.close();

  // Report dimensions for verification.
  const { fileSize } = await (async () => {
    const fs = require("fs");
    return { fileSize: fs.statSync(outPath).size };
  })();
  console.log(`OK  ${path.basename(outPath)}`);
  console.log(`    element: ${CANVAS_W} x ${CANVAS_H} CSS px @ ${SCALE}x`);
  console.log(`    output:  ${CANVAS_W * SCALE} x ${CANVAS_H * SCALE} px`);
  console.log(`    size:    ${(fileSize / 1024).toFixed(0)} KB`);
  console.log(`    path:    ${outPath}`);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
