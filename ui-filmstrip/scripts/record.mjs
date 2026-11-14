// Records what a reader sees through each UI transition. Chrome's screencast
// sends one frame per visual change (with its time), so a filmstrip of them
// shows every flicker, jump and animation step. In-page observers log layout
// shifts and heading/status text that changed after first paint.
//
// Usage (run from the project root, so Playwright resolves from it):
//   node record.mjs <scenarios.mjs> <outDir> [nameRegex]
// scenarios.mjs default-exports { baseURL, storageState?, layouts?, scenarios }
// where each scenario is { name, setup?(page, net), act(page, net), settleMs? }
// and `net` is the Toxiproxy helper below (no-op if Toxiproxy isn't running).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The project's Playwright: `playwright`, or the one @playwright/test brings.
const require = createRequire(path.join(process.cwd(), "package.json"));
const { chromium, devices } = (() => {
  try {
    return require("playwright");
  } catch {
    return require("@playwright/test");
  }
})();

const [scenarioFile, out = "rec", onlyArg] = process.argv.slice(2);
const only = onlyArg ? new RegExp(onlyArg) : null;
const config = (await import(pathToFileURL(path.resolve(scenarioFile)).href)).default;
const TOXI = process.env.TOXI_API ?? "http://127.0.0.1:8474/proxies/app";

/** Network states through Toxiproxy (scripts/net.sh starts it). */
// Toxiproxy not running: a silent no-op. Running but refusing a toxic: say so,
// or a "slow" recording is really a normal one. reset's DELETEs may 404.
const call = (url, init) =>
  fetch(url, init).then(
    (r) => r.ok || r.status === 404 || console.warn(`toxiproxy ${init.method} ${url}: ${r.status}`),
    () => {},
  );
const net = {
  /** Airplane mode: connections open but nothing ever comes back. */
  hang: async () => {
    for (const stream of ["upstream", "downstream"])
      await call(`${TOXI}/toxics`, { method: "POST", body: JSON.stringify({ name: `hang-${stream}`, type: "timeout", stream, attributes: { timeout: 0 } }) });
  },
  /** Offline: connections refused at once. */
  down: () => call(TOXI, { method: "POST", body: JSON.stringify({ enabled: false }) }),
  /** A slow network: ms of latency on every answer. */
  slow: (ms = 600) => call(`${TOXI}/toxics`, { method: "POST", body: JSON.stringify({ name: "slow", type: "latency", stream: "downstream", attributes: { latency: ms, jitter: Math.round(ms / 3) } }) }),
  /** Back to normal: called before every scenario. */
  reset: async () => {
    for (const name of ["hang-upstream", "hang-downstream", "slow"]) await call(`${TOXI}/toxics/${name}`, { method: "DELETE" });
    await call(TOXI, { method: "POST", body: JSON.stringify({ enabled: true }) });
  },
};

// Runs in the page from its first byte. Times are epoch ms, so they share a
// clock with the frames and survive navigations.
const watch = () => {
  window.__shifts = [];
  window.__swaps = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      if (!e.hadRecentInput)
        window.__shifts.push({ t: Math.round(performance.timeOrigin + e.startTime), value: +e.value.toFixed(4), nodes: e.sources?.map((s) => s.node?.nodeName + (s.node?.className ? `.${String(s.node.className).split(" ")[0]}` : "")).slice(0, 3) });
  }).observe({ type: "layout-shift", buffered: true });
  const seen = new WeakMap();
  new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target.nodeType === 3 ? r.target.parentElement : r.target;
      if (!el?.closest?.("h1,h2,h3,[role=status],[role=alert],output")) continue;
      const text = el.textContent?.trim().slice(0, 60);
      if (seen.has(el) && seen.get(el) !== text) window.__swaps.push({ t: Math.round(performance.timeOrigin + performance.now()), el: el.tagName, text });
      seen.set(el, text);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
};

const { defaultBrowserType, ...phone } = devices["iPhone 15"];
const layouts = config.layouts ?? { phone, desktop: { viewport: { width: 1280, height: 800 } } };
// CLS as browsers score it: the worst session window (shifts under 1 s apart,
// the window at most 5 s long), not the sum of every shift.
const clsOf = (shifts) => {
  let worst = 0, sum = 0, start = -Infinity, last = -Infinity;
  for (const { t, value } of shifts) {
    if (t - last > 1000 || t - start > 5000) (sum = 0), (start = t);
    sum += value;
    last = t;
    worst = Math.max(worst, sum);
  }
  return +worst.toFixed(4);
};

const browser = await chromium.launch();
const summary = [];
fs.mkdirSync(out, { recursive: true });

for (const [layout, device] of Object.entries(layouts))
  for (const s of config.scenarios) {
    if (only && !only.test(s.name)) continue;
    await net.reset();
    const context = await browser.newContext({ ...device, baseURL: config.baseURL, storageState: config.storageState, serviceWorkers: "allow" });
    await context.addInitScript(watch);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
    try {
      await s.setup?.(page, net);
    } catch (e) {
      errors.push(`setup: ${e.message.split("\n")[0]}`);
    }
    const dir = path.join(out, `${layout}-${s.name}`);
    fs.rmSync(dir, { recursive: true, force: true }); // no stale frames from a longer run
    fs.mkdirSync(dir, { recursive: true });
    const frames = [];
    const t0 = Date.now();
    const cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      const file = `${String(frames.length).padStart(3, "0")}.jpg`;
      fs.writeFileSync(path.join(dir, file), Buffer.from(data, "base64"));
      // The paint time, not when the frame reached us.
      frames.push({ t: Math.round((metadata.timestamp ? metadata.timestamp * 1000 : Date.now()) - t0), file });
      await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 });
    try {
      await s.act(page, net);
    } catch (e) {
      errors.push(`act: ${e.message.split("\n")[0]}`);
    }
    await page.waitForTimeout(s.settleMs ?? 3000);
    await cdp.send("Page.stopScreencast").catch(() => {});
    const m = await page.evaluate(() => ({ shifts: window.__shifts, swaps: window.__swaps, url: location.pathname + location.search })).catch(() => ({}));
    // Keep what happened while recording, on the frames' clock: setup's
    // page load is not this transition's.
    const since = (xs) => (xs ?? []).filter((x) => x.t >= t0).map((x) => ({ ...x, t: x.t - t0 }));
    m.shifts = since(m.shifts);
    m.swaps = since(m.swaps);
    const cls = clsOf(m.shifts);
    const entry = { name: s.name, layout, frames, errors, ...m, cls };
    fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify(entry, null, 1));
    summary.push({ name: `${layout}-${s.name}`, frames: frames.length, cls, swaps: m.swaps?.length ?? 0, errors });
    console.log(`${layout.padEnd(8)} ${s.name.padEnd(28)} frames=${String(frames.length).padStart(3)} cls=${cls} swaps=${JSON.stringify(m.swaps ?? []).slice(0, 160)}${errors.length ? ` ERR ${errors.join(" | ").slice(0, 160)}` : ""}`);
    await context.close();
  }

await net.reset();
fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 1));
await browser.close();
