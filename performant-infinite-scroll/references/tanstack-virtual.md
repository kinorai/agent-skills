# TanStack Virtual: complete recipes

Checked against `@tanstack/react-virtual` 3.14.x / `@tanstack/virtual-core` 3.17.x. If the installed version is older, check the option exists before using it (`node_modules/@tanstack/virtual-core/dist/esm/index.d.ts`).

## Contents
1. Window-scrolled feed (the default for full-page feeds)
2. Element-scrolled pane
3. Dynamic heights and Pretext
4. Scroll restoration with snapshots
5. Keeping the focused row mounted
6. Performance switches

## 1. Window-scrolled feed

```tsx
'use client'
import { useSuspenseInfiniteQuery } from '@tanstack/react-query'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { feedQuery, type FeedFilters, type FeedItem } from './feed-query'

const PREFETCH_ROWS = 25

export function Feed({ filters }: { filters: FeedFilters }) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } =
    useSuspenseInfiniteQuery(feedQuery(filters))
  const items = useMemo(() => data.pages.flatMap((p) => p.items), [data])

  // Offset of the list from the top of the document (header, filters bar, …)
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => setScrollMargin(listRef.current?.offsetTop ?? 0), [])

  const count = hasNextPage ? items.length + 1 : items.length // +1 = tail row
  const virtualizer = useWindowVirtualizer({
    count,
    estimateSize: () => 120, // near the upper end of real row heights
    overscan: 6,
    scrollMargin,
    getItemKey: (i) => items[i]?.id ?? '__tail__',
    useFlushSync: false, // avoids the React 19 flushSync warning
    initialRect: { width: 0, height: 900 }, // so SSR/first render emits rows, not an empty box
  })

  const virtualItems = virtualizer.getVirtualItems()
  const lastIndex = virtualItems.at(-1)?.index ?? -1
  useEffect(() => {
    if (lastIndex >= items.length - PREFETCH_ROWS && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      fetchNextPage()
    }
  }, [lastIndex, items.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage])

  return (
    <div ref={listRef} role="feed" aria-busy={isFetchingNextPage}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map((vi) => {
          const item = items[vi.index]
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {item ? (
                <Row item={item} posinset={vi.index + 1} />
              ) : isFetchNextPageError ? (
                <button type="button" onClick={() => fetchNextPage()}>Couldn't load more. Retry</button>
              ) : (
                <RowSkeleton />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const Row = memo(function Row({ item, posinset }: { item: FeedItem; posinset: number }) {
  return (
    <article aria-posinset={posinset} aria-setsize={-1} tabIndex={0}>
      {/* keep this cheap: no effects, fixed-size media boxes */}
    </article>
  )
})
```

Notes:
- The prefetch check skips a failed page (`isFetchNextPageError`), so a failing endpoint shows the retry row instead of being hammered.
- If the header height can change (a banner that dismisses, responsive filters), measure `scrollMargin` with a ResizeObserver instead of reading it once.
- `initialRect` only decides how many rows render before the browser measures. Server and client use the same value, so hydration matches.

## 2. Element-scrolled pane

Same as above with `useVirtualizer` and `getScrollElement: () => parentRef.current`. The parent needs a definite height and `overflow: auto`. Use `overflow-anchor: none` on the scroller if the browser's own scroll anchoring fights the virtualizer (jitter when rows above resize).

## 3. Dynamic heights and Pretext

- Put `measureElement` + `data-index` on the row's outer element. Don't give that element a fixed `height`.
- Anything that changes height after the first paint (images without dimensions, embeds, expanding "show more") triggers a correction. Reserve space up front. If a row really must grow, TanStack adjusts the scroll offset for rows above the viewport, which is fine. Growth *during* a fling is what causes visible jumps.
- Rows made mostly of text: [Pretext](https://github.com/chenglou/pretext) predicts wrapped text height from the font, width and line-height without touching the DOM. Feed that into `estimateSize` so estimates are almost exact. Follow TanStack's guide at `https://tanstack.com/virtual/latest/docs/pretext`. Cache `prepare()` per text+font, re-run `layout()` per width, and call `virtualizer.measure()` when width or font changes. Don't use it for rows whose height depends on images, embeds or arbitrary components.
- If the list lives in something that goes `display: none` (tabs, a Next.js Activity-hidden route), the ResizeObserver reports 0 for every row. Set `useCachedMeasurements: true` while hidden and back to `false` when visible.

## 4. Scroll restoration with snapshots

TanStack Query keeps the pages in memory (default `gcTime` 5 minutes, so raise it for feeds). The virtualizer needs measured sizes plus the offset, otherwise a restore lands on estimated positions and drifts.

```tsx
const storageKey = `feed-scroll:${pathname}?${search}`

// Read once, before creating the virtualizer
const [restore] = useState(() => {
  try {
    const raw = sessionStorage.getItem(storageKey)
    const parsed = raw ? (JSON.parse(raw) as { offset: number; count: number; cache: VirtualItem[] }) : null
    return parsed && parsed.count === count ? parsed : null // only if the same items are loaded
  } catch {
    return null
  }
})

const virtualizer = useWindowVirtualizer({
  // …options from §1
  initialOffset: restore?.offset,
  initialMeasurementsCache: restore?.cache,
})

useLayoutEffect(() => {
  if (restore) virtualizer.scrollToOffset(restore.offset) // initialOffset sets the range; this moves the page
  return () => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ offset: virtualizer.scrollOffset ?? 0, count, cache: virtualizer.takeSnapshot() }),
    )
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- save once on unmount
}, [])
```

- The saved `count` has to match on restore. If the query was garbage-collected and only page one came back, a stale snapshot puts the user in the wrong place. Discard it instead.
- `takeSnapshot()` only includes rows that were actually measured. Unmeasured rows fall back to `estimateSize`, which is fine because they're far from the viewport.
- Under Next.js Cache Components the route is usually kept alive, so none of this runs. See `nextjs.md`.

## 5. Keeping the focused row mounted

When the focused row scrolls out of range, it unmounts and focus falls back to `<body>`. Keep that row rendered:

```tsx
import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual'

const focusedIndex = useRef<number | null>(null)
const rangeExtractor = useCallback((range: Range) => {
  const indexes = defaultRangeExtractor(range)
  const f = focusedIndex.current
  return f !== null && !indexes.includes(f) ? [...indexes, f].sort((a, b) => a - b) : indexes
}, [])

// on the feed container:
onFocus={(e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-index]')
  focusedIndex.current = row ? Number(row.dataset.index) : null
}}
onBlur={(e) => {
  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusedIndex.current = null
}}
```

## 6. Performance switches

| Option | When |
|---|---|
| `overscan: 5–10` | Blank edges on fling *after* rows are already cheap |
| `useFlushSync: false` | React 19 warning, or low-end devices. Slightly less exact sync during scroll |
| `directDomUpdates: true` | Rows re-render on every scroll frame and profiling shows React render cost. The virtualizer writes positions to the DOM itself and only re-renders when the range changes. Requirements: rows are `position: absolute; top: 0; left: 0` without their own `transform`/`top`, and the inner container takes `ref={virtualizer.containerRef}` and **no** `height` style. Set it once at mount. |
| `isScrollingResetDelay` / `virtualizer.isScrolling` | Swap heavy row content (video, charts) for a placeholder while `isScrolling` is true |
| `lanes: n` | Masonry or grid of cards. Set the cross-axis position from `vi.lane` |

React Compiler: `useVirtualizer` returns a mutable instance, and `eslint-plugin-react-hooks` v7 reports it as an incompatible library (TanStack/virtual#1119). Put the virtualizer and its rows in their own leaf component so the compiler only skips that component.
