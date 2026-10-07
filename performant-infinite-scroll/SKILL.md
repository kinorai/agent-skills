---
name: performant-infinite-scroll
description: Production-grade infinite scroll and long lists in React and Next.js. Use when building or fixing a feed, timeline, activity stream, "load more" list, chat or log history, search results, or any long list or table; when choosing or using TanStack Virtual, virtua, react-virtuoso or useInfiniteQuery; and for scroll complaints even when nobody says "infinite scroll" or "virtualization": jank or blank rows on a fast fling, duplicate or missing items between pages, jumps when older items are prepended, lost position after pressing back. Not for React Native (FlashList and Legend List have their own rules).
---

# Performant infinite scroll (React / Next.js)

A good infinite list meets four promises. Design every decision around them:

1. **The user never sees the loading edge.** The next page is already there before they reach the bottom, even on a fast fling over a slow network.
2. **The DOM stays small.** Rendered rows stay roughly constant whether 50 or 50,000 items are loaded, so scrolling stays at 60fps.
3. **Back returns them to where they were.** They open an item, press back, and land on the same row with the same pages loaded.
4. **It works without a mouse or eyes.** Keyboard and screen-reader users can reach, read and leave the list.

Most broken infinite scrolls break one of these, usually #1 (loading too late) or #3 (position lost).

## Step 1: Pick the tier. Don't virtualize by reflex

Virtualization has real costs. Ctrl+F can't find unmounted rows. Screen readers see a partial list. Anchor links break. You also pay for measurement bugs. Use the lightest tier that meets the promises.

| Situation | Approach |
|---|---|
| The list is bounded and small (roughly ≤300 simple rows, ever) | Render everything. Add `content-visibility: auto; contain-intrinsic-size: auto 80px;` to rows so the browser skips layout and paint for off-screen rows. No JS, and find-in-page and a11y stay intact. |
| Unbounded feed, rows fairly light, sessions rarely go past a few hundred items | Infinite loading **without** virtualization: `useInfiniteQuery` + IntersectionObserver sentinel + `content-visibility`. Add `maxPages` if memory matters. |
| Unbounded or large (1,000+ rows), or heavy rows | Infinite loading **plus** virtualization. |

**Choosing a virtualizer:**

- **TanStack Virtual (`@tanstack/react-virtual`)**: the default. It's headless, the most widely used, and actively maintained. Since virtual-core 3.17 it also does end-anchored chat (`anchorTo: 'end'`, `followOnAppend`) and restoration snapshots (`takeSnapshot` / `initialMeasurementsCache`). Older comparison tables, including virtua's README, still say it can't. Pin a recent 3.17.x, because the chat anchoring got several fixes in September 2026.
- **virtua**: pick it when you want a component instead of a hook (`<VList>`, `<WindowVirtualizer>`), the least code, or Server Components rendered as rows (the only one that supports that directly).
- **react-virtuoso**: pick it when you need grouped sticky headers, a real `<table>` (`TableVirtuoso`) or masonry out of the box.
- **Avoid** `react-virtualized` (unmaintained) and tutorials using react-window **v1** APIs (`FixedSizeList`, `VariableSizeList`). react-window v2 has a different API and is fine for fixed-height rows only.

## Step 2: Data layer. Cursor pages through `useInfiniteQuery`

Use **cursor (keyset) pagination, not offset.** With offsets, a row inserted at the top while someone scrolls shifts every page. The user then sees duplicates or silently misses items, and deep pages get slower (`OFFSET 5000` still scans 5,000 rows). A cursor like "items older than (created_at, id)" stays stable and fast at any depth. Backend recipe: `references/backend-cursor.md`.

Define the options once, so the server prefetch and the client hook share the exact same key:

```ts
// feed-query.ts: shared by the Server Component prefetch and the client hook
import { infiniteQueryOptions } from '@tanstack/react-query'

export type FeedPage = { items: FeedItem[]; nextCursor: string | null }

export const feedQuery = (filters: FeedFilters) =>
  infiniteQueryOptions({
    queryKey: ['feed', filters],
    queryFn: ({ pageParam, signal }) => fetchFeedPage({ filters, cursor: pageParam, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined, // undefined means no more pages
    staleTime: 60_000,
  })
```

Rules that matter:

- **Page size.** One page should cover several screens of fast scrolling. For slim rows that's typically 50–100 items, and more for tiny rows. Bigger pages with slim payloads beat many small requests.
- **Slim list payloads.** Send only what the row renders. Truncate long text on the server, and keep nested detail data for the detail page. Aim for well under ~1 KB per row. Don't bother abbreviating JSON keys, since gzip already removes that redundancy.
- **Pass `signal` through** so changing filters aborts in-flight pages instead of racing them.
- **Filters belong in the query key.** A filter change becomes a new cache entry that starts from page one, instead of mixing pages from two filters.
- **Refetches are sequential over every loaded page.** A stale feed with 30 pages refetches 30 requests one after another. Give feeds a real `staleTime`, think about `refetchOnWindowFocus: false`, and use `maxPages` (plus `getPreviousPageParam`) for very long sessions to cap memory and refetch cost.
- **Flatten once**, with `useMemo(() => data?.pages.flatMap(p => p.items) ?? [], [data])`. If the backend can return an item twice across pages (for example when a new item arrives mid-session), dedupe by id here.

## Step 3: Trigger. Fetch ahead of the user, not at the bottom

Most tutorials, including TanStack's own example, fetch only when the **last** row appears. That's exactly promise #1 broken: the user reaches the edge and waits. Trigger when the user is still one or two screens away.

**Virtualized: trigger off the rendered range.** A sentinel element doesn't work well inside virtualized content.

```tsx
const lastIndex = virtualizer.getVirtualItems().at(-1)?.index ?? -1
const PREFETCH_ROWS = 25 // about 2 viewports of rows; raise it for fast flings or slow APIs

useEffect(() => {
  if (lastIndex >= items.length - PREFETCH_ROWS && hasNextPage && !isFetchingNextPage) {
    fetchNextPage()
  }
}, [lastIndex, items.length, hasNextPage, isFetchingNextPage, fetchNextPage])
```

Depend on the index **number**, not the `getVirtualItems()` array. The array's identity changes every render.

**Non-virtualized: an IntersectionObserver sentinel with a large, viewport-relative margin.**

```tsx
const sentinelRef = useRef<HTMLDivElement>(null)
useEffect(() => {
  const el = sentinelRef.current
  if (!el || !hasNextPage) return
  const io = new IntersectionObserver(
    ([entry]) => { if (entry.isIntersecting && !isFetchingNextPage) fetchNextPage() },
    { rootMargin: '0px 0px 200% 0px' }, // start two screens early, and it scales with the screen
  )
  io.observe(el)
  return () => io.disconnect()
}, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length])
```

Including `items.length` in the dependencies is deliberate. IntersectionObserver only fires on **changes**. If one page doesn't fill the screen, the sentinel stays visible and no new event arrives, so loading silently stops. Re-observing after each page makes it fire again.

Always guard with `hasNextPage && !isFetchingNextPage`. Without the guard you get duplicate requests or an endless fetch loop.

## Step 4: Render cheap, stable rows

- **Keys = item id, never index.** With TanStack Virtual, pass `getItemKey: (i) => items[i].id`. Index keys make measurement caches and focus follow the wrong row after inserts, and they break prepend anchoring completely.
- **Dynamic heights are fine. Measure them.** Put `ref={virtualizer.measureElement}` and `data-index={vi.index}` on each row. Make `estimateSize` close to the upper end of real row heights, since TanStack recommends estimating the largest likely size for dynamic rows. Rows made mostly of text can get their heights predicted before render with Pretext (see `references/tanstack-virtual.md`).
- **Reserve space for media.** Give images `width`/`height` (or an `aspect-ratio` box) so a row's height doesn't change after it's been measured. Late height changes are the #1 cause of rows jumping while you scroll up.
- **Position with `transform: translateY(...)`**, not `top`, and keep rows `position: absolute` inside a `position: relative` container sized to `getTotalSize()`.
- **Keep rows light.** Memoize the row component. Don't create per-row effects, observers or subscriptions, and don't run heavy markdown or syntax highlighting during scroll. Blank flashes during a fling mean rows take too long to render. Fix the rows first, then raise `overscan` (the default is 1, and 5–10 is typical).
- **A tail row for loading, end and error states.** Use `count: hasNextPage ? items.length + 1 : items.length`. Render a skeleton in that last slot, not a spinner that shifts layout. On error, show an inline "Retry" button there, and never retry automatically in a loop.
- **Window or element scroller.** A full-page feed should scroll the window (`useWindowVirtualizer` / `<WindowVirtualizer>`). That gets native mobile behavior: the URL bar collapses and scroll-to-top works. Remember `scrollMargin` for content above the list. Use an element scroller only for panes like sidebars and chat.

## Step 5: Next.js App Router specifics

The first page is server-rendered so there's no spinner on arrival, and later pages come from a GET Route Handler. Details and full code are in `references/nextjs.md`. Key points:

- **Server-render page one** with `void queryClient.infiniteQuery(feedQuery(filters))` + `dehydrate` inside `<HydrationBoundary>`. In TanStack Query 5.102+, `prefetchInfiniteQuery` is deprecated in favor of `infiniteQuery`.
- **Don't fetch pages with Server Actions.** Next.js dispatches them one at a time per client, and they're POSTs, so they can't be cached. Use a GET Route Handler.
- **Big lists of `<Link>`s**: each visible link prefetches its route, so a fling fires hundreds of prefetches. Set `prefetch={false}` on feed rows and call `router.prefetch(href)` yourself on `pointerenter` / `focus`. In the App Router, `prefetch={false}` also disables prefetch on hover.
- **Cache Components (`cacheComponents: true`) keeps up to 3 visited routes alive in React `<Activity>`**, hidden with `display: none`. Back navigation then restores the list for free, but hidden rows measure as 0px. Read the Activity section in `references/nextjs.md`.
- **Scroll restoration** on back, when the route wasn't kept alive, needs a snapshot of both the measurements and the offset, plus the query cache still holding the pages. Recipe in `references/nextjs.md`.
- **SEO**: crawlers don't scroll. If the items must be indexed, also render real paginated links (`<a href="?cursor=…">Next page</a>`) that work without JS.

## Step 6: Chat, logs, and loading in both directions

This is a different scroll contract. The list starts at the bottom, older history is prepended at the top, and new messages follow only if the user is already at the bottom. Don't hand-roll `scrollTop += delta` compensation or `flex-direction: column-reverse` tricks. Use `anchorTo: 'end'` + `followOnAppend` in TanStack Virtual, or `shift` in virtua. Full pattern: `references/chat-bidirectional.md`.

## Step 7: Accessibility and UX

Follow the WAI-ARIA feed pattern. Details and code are in `references/a11y-ux.md`. At minimum:

- Container `role="feed"` with `aria-busy` while a page loads. Rows are `role="article"` with `aria-posinset` and `aria-setsize` (use `-1` when the total is unknown).
- Keyboard focus must not vanish when a focused row scrolls out and unmounts. Keep it mounted (a TanStack `rangeExtractor` that includes the focused index, or virtua's `keepMounted`).
- Don't put essential links in a footer below an endless feed, because nobody can reach it. Offer a "Load more" button where auto-loading hurts, such as near a footer or in search results.

## Step 8: Verify against the four promises

Don't call it done on "it loads more". Check:

| Promise | How to check |
|---|---|
| No loading edge | DevTools network "Fast 4G" or slower, then fling hard to the bottom several times. You should never see skeleton rows under normal fast scrolling. If you do, raise `PREFETCH_ROWS`, the page size, or `rootMargin`. |
| Small DOM | While scrolling through 1,000+ items, `document.querySelectorAll('[data-index]').length` stays roughly visible rows + 2×overscan. The Performance panel shows no long tasks (>50ms) during a fling. |
| Back restores | Scroll 5+ pages, open an item, press back. You land on the same row, with no refetch waterfall and no jump. |
| Accessible | Tab through three pages by keyboard. Focus stays visible and never jumps to `<body>`. A screen reader announces the feed and its articles. |

Also test: a filter change mid-scroll (old pages abort, the list resets to the top), the end of data (the tail row says so and fetching stops), a first page shorter than the viewport (loading continues), and a page error (inline retry works).

## Symptom → cause → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| Duplicate or missing items between pages | Offset pagination, or a sort without a unique tiebreaker | Keyset cursor on `(sort_key, id)` |
| Rows jump while scrolling **up** | Estimates far off, or media resizing after measurement | Better `estimateSize`, reserved media boxes, stable keys |
| Endless requests | Missing `isFetchingNextPage` guard, or `getNextPageParam` never returns `undefined` | Add the guard, and return `undefined` at the end |
| Loading stops after page 1 | IntersectionObserver never re-fires because the sentinel stayed visible | Re-observe on `items.length`, or trigger off the virtual range |
| Blank flashes on fast fling | Heavy rows, or overscan too low | Lighter rows, then `overscan` 5–10. TanStack's `directDomUpdates` skips React re-renders on scroll |
| `flushSync was called from inside a lifecycle method` (React 19) | TanStack Virtual's default `useFlushSync: true` | `useFlushSync: false` |
| React Compiler / `eslint-plugin-react-hooks` says "incompatible library" on `useVirtualizer` | The virtualizer instance is mutable (TanStack/virtual#1119, still open) | Keep the virtualizer in a small leaf component so only that component is left unoptimized |
| Prepending history makes the view jump | Top-anchored virtualizer, index keys | `anchorTo: 'end'` + `getItemKey` from ids (or virtua `shift`) |
| Back button lands at the top or somewhere random | Pages were refetched or garbage-collected, or measurements were lost | Keep the query in cache (`gcTime`), restore snapshot + offset |

## References (read when relevant)

- `references/tanstack-virtual.md`: full element and window list components, dynamic measurement, Pretext, `directDomUpdates`, restoration snapshot, keeping focus mounted.
- `references/nextjs.md`: App Router server-rendered first page, Route Handler pages, Activity / Cache Components, scroll restoration, SEO fallback.
- `references/chat-bidirectional.md`: chat and log feeds with TanStack Virtual end anchoring, the virtua `shift` alternative, streaming output, a "jump to latest" button.
- `references/backend-cursor.md`: keyset pagination SQL, cursor encoding, the `limit + 1` trick, indexes, and avoiding dupes with live inserts.
- `references/a11y-ux.md`: WAI-ARIA feed markup, focus handling, load-more fallback, reduced motion.
