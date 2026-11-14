---
name: ui-filmstrip
description: See a web UI move, frame by frame, to find flicker, layout jumps, content swapped after paint, janky animations and broken offline/slow-network states. Records each transition with Chrome's screencast (one frame per visual change), lays the frames out as filmstrip PNGs you can read, and logs layout shifts and late text swaps. Use it whenever the user reports or suspects flicker, flashing, a jump, "it refreshes before my eyes", a slow or stuttering transition, or asks you to watch, record, film, video or screenshot the app moving; and to check how a PWA behaves online, on a slow network, in airplane mode (hung network) or offline. Use it even when they only say "go through all the screens and look for bugs" in a web app.
---

# UI filmstrip

You can't watch video, but you can read images. So record each transition as
the frames the screen actually painted, each with its time, and read them as a
filmstrip. A flicker is one or two odd frames between two good ones, so you
see it the way a person does. The numbers (layout shift, text swapped after
paint) point at what to look at; the frames are the evidence.

## 1. Serve what users get

Record a **production build** (`next build && next start`, or the project's
equivalent), never a dev server: dev adds overlays, recompiles mid-recording
and skips service workers. On a low-RAM machine run the build and the browser
in Docker (`mcr.microsoft.com/playwright:v<version>-noble`, `--network host`,
the project mounted at `/work`), one at a time.

For network states, put Toxiproxy in front of the app:

```bash
scripts/net.sh start 3200 3100   # the app on :3100, record against :3200
```

A sign-up or sign-in through the proxy can fail its origin check (another
port). Sign in on the app's own port and reuse the storage state: cookies
aren't tied to a port.

## 2. Write the scenarios

One file per run, default-exporting `{ baseURL, storageState?, layouts?, scenarios }`.
Each scenario is `{ name, setup?(page, net), act(page, net), settleMs? }`:
`setup` gets the page into place (unrecorded), `act` is the transition
(recorded), then the recording runs `settleMs` more (3000 by default).
Layouts default to an iPhone 15 viewport and a 1280×800 desktop; each
scenario runs in each, in a fresh context with the service worker allowed.

```js
const click = (l) => l.evaluate((el) => el.click()); // see Pitfalls
export default {
  baseURL: "http://localhost:3200",
  storageState: "e2e/.auth/owner.json",
  scenarios: [
    { name: "cold-load", act: (p) => p.goto("/", { waitUntil: "commit" }) },
    { name: "open-post", setup: (p) => p.goto("/"), act: (p) => click(p.locator("article a").nth(1)) },
    { name: "slow-open", setup: async (p, net) => { await p.goto("/"); await net.slow(600); }, act: (p) => click(p.locator("article a").nth(2)), settleMs: 5000 },
    { name: "airplane-reload", setup: async (p, net) => { await p.goto("/"); await p.waitForTimeout(4000); await net.hang(); }, act: (p) => p.reload({ waitUntil: "commit" }), settleMs: 6000 },
    { name: "coming-back", setup: async (p, net) => { await p.goto("/"); await net.down(); await p.reload(); }, act: (p, net) => net.reset(), settleMs: 6000 },
  ],
};
```

Cover what users do: cold load, reload, every tab, open/close a detail and
Back, menus and sheets, scrolling a long list, settings; then the same moves
slow (`net.slow`), in airplane mode (`net.hang`), offline (`net.down`) and
coming back (`net.reset`). `net` resets before every scenario.

## 3. Record, lay out, read

```bash
node <skill>/scripts/record.mjs scenarios.mjs rec           # all
node <skill>/scripts/record.mjs scenarios.mjs rec 'open'    # by name
node <skill>/scripts/strips.mjs rec                          # rec/strip-*.png
```

Run both from the project root (they use its Playwright). Each line of the
record log gives the frame count, CLS and late text swaps: start reading the
strips with the highest CLS, any swaps, any errors, and the most frames for a
transition that should be instant. Then read every strip once anyway: a
switch sliding to its real state, a banner flashing in and out or a skeleton
blinking scores nothing.

## 4. Confirm before you call it a bug

- **Re-record the suspect with a plain click** (`el.click()` in `evaluate`).
  Playwright's `click()` scrolls the target into view first, which films as
  "the page jumps before navigating". It isn't the app.
- **A shift on a programmatic click** isn't a user-facing CLS: browsers mark
  shifts right after real input as expected. A layout that changes by design
  (a pane opening) isn't a jump.
- **Fix, rebuild, re-record the same scenario,** and read the new strip. That
  strip is the proof to show the user.

## Pitfalls

- **Screencast is Chromium-only.** For WebKit (Safari, iPhone), take
  screenshots per step instead (`webkit.launch()` with `devices["iPhone 15"]`).
- **Don't use `context.setOffline` in WebKit with a service worker:** every
  request the worker answers fails (playwright#42775). Use `net.down()`.
- **`context.route` can't hold the navigation preload,** so routing every
  request to "never answer" still lets a page load through. A real hang
  needs Toxiproxy's `timeout` toxic (`net.hang`).
- **A scenario that cuts the network and fails** leaves it cut for the next
  one unless it's reset; `record.mjs` resets before each.
- **No image tools needed:** the strips are an HTML grid shot by Playwright,
  with the frames inlined as base64 (a `setContent` page can't load
  `file://`).
- **Report the frame times.** "On at 134 ms, off from 215 ms" lets the user
  see what you saw. Attach the strip PNG (absolute path) when the user can
  view images.
