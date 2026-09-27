---
name: performant-infinite-scroll
description: Build infinite scroll lists that never show loading states — virtualization, eager prefetch, slim payloads, and buffer strategies used by the fastest production leaderboards.
version: 0.1.0
supportedAgents: ["universal", "claude-code", "windsurf", "cursor", "copilot"]
---

# Infinite Scroll

Build infinite scroll lists so fast that even an ultra-fast scroll wheel never catches the loading boundary.

This skill teaches the four pillars of high-performance infinite scroll, derived from analyzing production leaderboards that handle 4,000+ items with zero perceptible loading.

## The Four Pillars

### 1. Virtualized Rendering

Only render visible rows plus a small overscan buffer. The DOM should contain ~30-80 elements regardless of how many items are loaded.

**Why it matters:** Rendering 2,000 DOM nodes makes scrolling janky. Rendering 40 keeps it butter-smooth.

**How to implement:**

```typescript
// Conceptual pattern — adapt to your virtualization library
const virtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => ROW_HEIGHT, // Fixed height rows are critical
  overscan: 10, // Render 10 extra rows above/below viewport
})

// Only render virtual items, not the full list
return (
  <div ref={scrollRef} style={{ height: '100%', overflow: 'auto' }}>
    <div style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtualRow) => (
        <div
          key={virtualRow.key}
          style={{
            position: 'absolute',
            top: virtualRow.start,
            height: ROW_HEIGHT,
            width: '100%',
          }}
        >
          <Row data={items[virtualRow.index]} />
        </div>
      ))}
    </div>
  </div>
)
```

**Key requirements:**
- Rows MUST have fixed or predictable height — variable heights break fast scrolling
- Use `position: absolute` with calculated `top` values for each row
- The outer container holds the full scrollable height via a spacer element
- Overscan of 5-15 rows prevents flicker during normal scrolling

### 2. Large Pages with Eager Prefetch

Load 200 items per page instead of 20-50. Prefetch 2-3 pages ahead on initial load.

**Why it matters:** With 50-item pages, fast scrolling hits the loading boundary in under a second. With 200-item pages and 3 pages prefetched, you have a ~600-item buffer before the first fetch is even needed.

**How to implement:**

```typescript
const PAGE_SIZE = 200

// On initial load, fetch page 1 inline (SSR/RSC) and prefetch pages 2-3
const [items, setItems] = useState<Item[]>(initialItems) // Page 1 from server
const prefetchedRef = useRef<Map<number, Item[]>>(new Map())

useEffect(() => {
  // Eagerly prefetch next pages without blocking render
  void prefetchPage(2)
  void prefetchPage(3)
}, [])

async function prefetchPage(page: number) {
  if (prefetchedRef.current.has(page)) return
  const data = await fetch(`/api/items?page=${page}&limit=${PAGE_SIZE}`)
  const json = await data.json()
  prefetchedRef.current.set(page, json.items)
}

// When scroll approaches the buffer boundary, append prefetched data instantly
function loadMore() {
  const nextPage = Math.floor(items.length / PAGE_SIZE) + 1
  const prefetched = prefetchedRef.current.get(nextPage)
  if (prefetched) {
    setItems(prev => [...prev, ...prefetched])
    prefetchedRef.current.delete(nextPage)
    // Immediately start prefetching the NEXT page
    void prefetchPage(nextPage + 2)
  }
}
```

**Key requirements:**
- Server-render the first page inline (no loading spinner on initial visit)
- Start prefetching pages 2-3 immediately after mount
- When appending prefetched data, immediately queue the next prefetch
- The user should never see a loading state during scroll

### 3. Slim Row Payloads

Send only what the row needs to render. Every extra byte multiplied by thousands of rows adds up.

**Why it matters:** If each row payload is 1KB (description, metadata, nested objects), 200 rows = 200KB per page. At 100 bytes per row, 200 rows = 20KB — 10x smaller, 10x faster.

**Design your API response for the list, not the detail page:**

```typescript
// BAD — detail-page payload used for list rows
interface HeavyItem {
  id: string
  name: string
  namespace: string
  description: string          // Could be 500+ chars
  readme: string               // Kilobytes
  versions: Version[]          // Nested array
  trustScore: TrustData        // Nested object
  supportedAgents: string[]    // Array
  createdAt: string
  updatedAt: string
  downloads: number
  license: string
  sourceUrl: string
}

// GOOD — list-optimized payload
interface ListItem {
  id: string
  name: string
  ns: string                   // Abbreviated key
  type: string
  desc: string                 // Truncated to 80 chars server-side
  dl: number                   // Downloads, abbreviated key
  at: string                   // updatedAt, abbreviated key
}
```

**Key requirements:**
- Truncate descriptions server-side (don't send 500 chars to show 80)
- Use short field names for high-volume responses
- Nested objects (trust data, versions, agents) belong on the detail page, not in list responses
- Target 80-150 bytes per item

### 4. Smart Scroll Detection

Use IntersectionObserver with a large rootMargin to trigger prefetch well before the user reaches the end.

```typescript
const observer = new IntersectionObserver(
  (entries) => {
    if (entries[0]?.isIntersecting) {
      loadMore()
    }
  },
  {
    // Start loading 2000px before the sentinel is visible
    // At ~40px per row, this is ~50 rows of buffer
    rootMargin: '0px 0px 2000px 0px',
  }
)

// Place sentinel at the end of the rendered list
observer.observe(sentinelRef.current)
```

**Key requirements:**
- rootMargin of 1500-2000px for aggressive prefetch (not the typical 200-600px)
- Combined with large page sizes, this means the next page is requested when the user is still 50+ rows from the bottom
- Abort in-flight requests when filters/search changes (use AbortController)
- Use a generation counter to discard stale responses

## Anti-Patterns

**Don't do these:**

- **Small pages (20-50 items)** — Fast scrolling will always catch the loading boundary
- **Rendering all loaded items to DOM** — 1,000 DOM nodes = janky scroll
- **Fetching on scroll without buffer** — Network latency makes this feel slow
- **Sending full item data in list responses** — Wasted bandwidth, slower parsing
- **Variable-height rows without measurement** — Breaks virtualization positioning
- **Loading spinners in the scroll path** — Skeleton rows are acceptable; spinners block flow

## Performance Targets

| Metric | Target |
|--------|--------|
| DOM elements in list | 30-80 regardless of total items |
| Initial buffer | 400-600 items before first scroll |
| Time to first scroll-triggered fetch | >3 seconds of fast scrolling |
| Payload per page (200 items) | <30KB |
| Scroll FPS | 60fps constant |

## Library Recommendations

| Library | Best For | Notes |
|---------|----------|-------|
| @tanstack/react-virtual | React apps | Headless, flexible, good TypeScript support |
| react-window | React apps (simpler) | Fixed-size lists, smaller bundle |
| @tanstack/virtual | Framework-agnostic | Core virtualizer, no framework dependency |
| Custom IntersectionObserver | Simple cases | No library needed for basic infinite scroll without virtualization |

## When NOT to Use This

- Lists under 100 items — just render them all
- Items with highly variable heights and rich content — consider pagination instead
- SEO-critical content that needs all items indexable — use server-side pagination with `<link rel="next">`
