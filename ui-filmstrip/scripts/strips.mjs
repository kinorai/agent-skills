// Lays each recorded scenario out as one PNG filmstrip: every frame with its
// time, plus CLS, the shifts and any errors in the title. Read the PNGs.
// Usage (from the project root): node strips.mjs <recDir> [nameRegex]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { chromium } = (() => {
  try {
    return require("playwright");
  } catch {
    return require("@playwright/test");
  }
})();
const [rec = "rec", onlyArg] = process.argv.slice(2);
const only = onlyArg ? new RegExp(onlyArg) : null;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1900, height: 800 } });
for (const name of fs.readdirSync(rec).sort()) {
  const json = path.join(rec, name, "frames.json");
  if (!fs.existsSync(json) || (only && !only.test(name))) continue;
  const data = JSON.parse(fs.readFileSync(json, "utf8"));
  const narrow = data.layout === "phone";
  const width = narrow ? 170 : 360;
  // Images inlined: setContent's page can't load file:// URLs.
  const cells = data.frames.slice(0, narrow ? 30 : 20).map((f) => `<figure><figcaption>${f.t}ms</figcaption><img style="width:${width}px" src="data:image/jpeg;base64,${fs.readFileSync(path.join(rec, name, f.file)).toString("base64")}"></figure>`).join("");
  const shifts = JSON.stringify((data.shifts ?? []).filter((s) => s.value > 0.001)).slice(0, 300);
  await page.setContent(`<style>body{margin:6px;font:12px system-ui;background:#ccc}main{display:flex;flex-wrap:wrap;gap:4px}figure{margin:0;background:#fff;padding:2px}img{display:block;border:1px solid #888}h1{font-size:14px;margin:2px 0 6px}</style><h1>${name} · ${data.frames.length} frames · CLS ${data.cls} · ${shifts} ${data.errors.join(" ")}</h1><main>${cells}</main>`);
  await page.screenshot({ path: path.join(rec, `strip-${name}.png`), fullPage: true });
  console.log(path.join(rec, `strip-${name}.png`));
}
await browser.close();
