# Next.js App Router

Written for Next.js 16 (App Router, React 19) and TanStack Query 5.102+. Before relying on a detail, check the project's own docs in `node_modules/next/dist/docs/`, because the App Router changes quickly. The relevant guides are `01-app/02-guides/client-side-data-fetching/tanstack-query.md`, `01-app/02-guides/preserving-ui-state.md` and `01-app/02-guides/server-actions.md`.

## Contents
1. Architecture
2. Server-rendered first page
3. Route Handler for later pages
4. Cache Components and `<Activity>`
5. Scroll restoration without Activity
6. Links, SEO, filters in the URL
7. E2E testing caveat

## 1. Architecture

```
page.tsx (Server Component)
  └─ starts the page-one query on the server, dehydrates → <HydrationBoundary>
       └─ Feed (Client Component): useSuspenseInfiniteQuery(feedQuery(filters))
            └─ pages 2..n: fetch('/api/feed?cursor=…') → app/api/feed/route.ts (GET)
```

The server and the Route Handler call the **same** data function (`getFeedPage`) from the application layer. If the project follows clean architecture, that's a use case behind a port, and the UI never imports the database directly.

## 2. Server-rendered first page

```tsx
// app/feed/page.tsx
import { Suspense } from 'react'
import { dehydrate, defaultShouldDehydrateQuery, HydrationBoundary, QueryClient } from '@tanstack/react-query'
import { feedQuery, parseFilters } from './feed-query'
import { getFeedPage } from '@/server/feed' // server-only data access
import { Feed } from './feed'

export default function Page({ searchParams }: PageProps<'/feed'>) {
  return (
    <Suspense fallback={<FeedSkeleton />}>
      {searchParams.then((sp) => <FeedData filters={parseFilters(sp)} />)}
    </Suspense>
  )
}

function FeedData({ filters }: { filters: FeedFilters }) {
  const queryClient = new QueryClient()
  // Not awaited: page one streams in. Swap in `await` if the HTML must contain the rows (SEO).
  void queryClient
    .infiniteQuery({ ...feedQuery(filters), queryFn: ({ pageParam }) => getFeedPage({ filters, cursor: pageParam }) })
    .catch(() => {}) // the client retries. Don't crash the stream

  return (
    <HydrationBoundary
      state={dehydrate(queryClient, {
        shouldDehydrateQuery: (q) => defaultShouldDehydrateQuery(q) || q.state.status === 'pending',
      })}
    >
      <Feed filters={filters} />
    </HydrationBoundary>
  )
}
```

- On the server, override `queryFn` to call the data layer directly. The client's `fetch('/api/…')` uses a relative URL that only resolves in the browser.
- `staleTime` > 0 in `feedQuery` stops the client from refetching the page it just received.
- `prefetchInfiniteQuery` / `fetchInfiniteQuery` still work but are deprecated since 5.102 in favor of `queryClient.infiniteQuery()`. On older versions, use `prefetchInfiniteQuery`.
- The virtualizer needs an `initialRect` (TanStack) or `ssrCount` (virtua) to render rows before the browser has measured anything. Otherwise the server HTML contains an empty spacer.

## 3. Route Handler for later pages

```ts
// app/api/feed/route.ts
import type { NextRequest } from 'next/server'
import { getFeedPage, InvalidCursorError } from '@/server/feed'
import { parseFilters } from '@/app/feed/feed-query'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  try {
    const page = await getFeedPage({ filters: parseFilters(sp), cursor: sp.get('cursor') })
    return Response.json(page, { headers: { 'Cache-Control': 'private, max-age=30' } })
  } catch (e) {
    if (e instanceof InvalidCursorError) return Response.json({ error: 'invalid cursor' }, { status: 400 })
    throw e
  }
}
```

Client side:

```ts
export async function fetchFeedPage({ filters, cursor, signal }: { filters: FeedFilters; cursor: string | null; signal: AbortSignal }) {
  const qs = new URLSearchParams(serializeFilters(filters))
  if (cursor) qs.set('cursor', cursor)
  const res = await fetch(`/api/feed?${qs}`, { signal })
  if (!res.ok) throw new Error(`feed ${res.status}`)
  return (await res.json()) as FeedPage
}
```

**Why not Server Actions?** Next.js dispatches Server Actions one at a time per client ("Server Actions are queued. Using them for data fetching introduces sequential execution"). A page fetch would wait behind any mutation in flight, and a POST can't be cached by the browser or a CDN. Keep Server Actions for mutations. After a mutation that changes the feed, call `queryClient.invalidateQueries({ queryKey: ['feed'] })`, or better, `setQueryData` the single changed item so dozens of pages aren't refetched.

Pick `Cache-Control` per feed: `private` for per-user feeds, and `public, s-maxage=…` for public ones. Cursor URLs are naturally cacheable because the same cursor always returns the same page.

## 4. Cache Components and `<Activity>`

With `cacheComponents: true`, Next.js doesn't unmount pages on navigation. It hides up to **3** recent routes in React `<Activity>`, which keeps the DOM with `display: none` and preserves both React state and scroll positions. For infinite lists this is mostly great: back navigation shows the exact same DOM, pages and position with no work at all.

Things to know:
- **Effects clean up on hide and run again on show.** A virtualizer's scroll and resize subscriptions detach and reattach. Anything you save "on unmount" (like the snapshot in `tanstack-virtual.md` §4) runs on every hide too, which is harmless.
- **Hidden rows measure as 0px.** If rows collapse, or the list jumps after returning, measurement happened while hidden. TanStack Virtual's `useCachedMeasurements` exists for this: turn it on while hidden and off when visible. The Next.js docs show the hide-detection idiom, a `useLayoutEffect` cleanup that runs synchronously before hiding. This combination is new, so verify it in a real browser.
- **Transient UI stays open.** Menus or popovers opened from a row are still open when the user comes back. Close them in a `useLayoutEffect` cleanup, as the Next.js guide shows.
- **Resetting on purpose.** To force a fresh list on forward navigation but keep it on back/forward, key the subtree with `useRouter().bfcacheId`.
- **After the 4th route**, the oldest one is evicted and re-renders fresh. The query cache and the snapshot recipe (§5) then take over.

## 5. Scroll restoration without Activity

Without Cache Components, or after eviction, the route remounts. Restoring well needs:
1. **The data**: TanStack Query still has the pages if `gcTime` hasn't expired. Raise `gcTime` for feeds (for example 30 minutes). Don't refetch on mount (`staleTime`), or every page refetches one after another before the position can be restored.
2. **The geometry**: measured sizes + offset (TanStack `takeSnapshot` / `initialMeasurementsCache` / `initialOffset`, or virtua `handle.cache` + the `cache` prop). Save it in `sessionStorage`, keyed by pathname + search.
3. **A guard**: restore only if the item count matches what was saved. Otherwise start fresh at the top rather than landing somewhere random.

App Router's built-in scroll restoration only restores window scroll, and only works if the page is already as tall as before. A virtualized list starts at estimated sizes, so the built-in restore alone lands in the wrong place. That's why the snapshot matters.

## 6. Links, SEO, filters in the URL

- **`<Link prefetch={false}>` on feed rows.** Every link in the viewport prefetches its route by default, and a fling through a feed fires hundreds of prefetches. In the App Router, `prefetch={false}` disables prefetching both on entering the viewport **and on hover** (in the Pages Router, hover still prefetches). So add intent prefetching back yourself: `onPointerEnter={() => router.prefetch(href)}` and the same on `onFocus`.
- **Filters and sort go in `searchParams`** so they're shareable and survive reloads, and they're part of the query key. Don't put the scroll cursor in the URL for normal users, because it breaks "share this feed".
- **SEO**: crawlers don't scroll or run your IntersectionObserver. If items must be indexed, `await` page one in the Server Component, and render a real `<a href="/feed?cursor=…">Next page</a>` after the list. Make the page render correctly for `?cursor=` (as the starting page) so crawlers can follow the chain.

## 7. E2E testing caveat

With Cache Components, hidden routes stay in the DOM. Playwright locators can match rows in a hidden previous page. Scope locators to the visible route, or assert `toBeVisible()` rather than counting raw `[data-index]` nodes.
