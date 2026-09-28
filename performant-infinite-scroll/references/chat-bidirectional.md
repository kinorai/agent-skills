# Chat, logs, and loading in both directions

The contract is different from a feed. The view starts at the **newest** item at the bottom. Scrolling up loads **older** pages, which are prepended, and the visible message must not move. New items are appended, and the view follows them only if the user is already at the bottom. A growing (streaming) last message keeps the bottom pinned.

Don't use `flex-direction: column-reverse`, `scaleY(-1)` inversion, or manual `scrollTop += heightDelta`. They break selection, accessibility and find-in-page, and they misbehave on iOS. Both libraries below handle anchoring themselves.

## Data: pages in both directions with TanStack Query

The first page is the latest messages. Older history arrives through `fetchPreviousPage`, which **prepends** a page, so `data.pages` stays in oldest→newest order and flattening gives chronological order.

```ts
export const chatQuery = (roomId: string) =>
  infiniteQueryOptions({
    queryKey: ['chat', roomId],
    queryFn: ({ pageParam, signal }) => fetchMessages({ roomId, before: pageParam, signal }), // latest when null
    initialPageParam: null as string | null,
    getPreviousPageParam: (first) => first.olderCursor ?? undefined, // older history
    getNextPageParam: () => undefined, // new messages arrive by push, not by paging
    staleTime: Infinity, // the socket keeps it fresh. Refetching every page is wasteful
  })
```

New messages arriving over a WebSocket or SSE: append to the **last** page in the cache instead of refetching.

```ts
queryClient.setQueryData(chatQuery(roomId).queryKey, (d) =>
  d && { ...d, pages: d.pages.map((p, i) => (i === d.pages.length - 1 ? { ...p, items: [...p.items, msg] } : p)) },
)
```

Dedupe by message id when flattening, because an optimistic message and its server echo can both land.

## TanStack Virtual (virtual-core ≥ 3.17.5; prefer the latest 3.17.x)

```tsx
const messages = useMemo(() => dedupeById(data.pages.flatMap((p) => p.items)), [data])

const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 72,
  getItemKey: (i) => messages[i]!.id, // required: index keys can't tell a prepend from an append
  anchorTo: 'end',
  followOnAppend: true, // or 'smooth'
  scrollEndThreshold: 80, // px from the bottom that still counts as "pinned"
  overscan: 6,
  useFlushSync: false,
})

// Start at the latest message
useLayoutEffect(() => { virtualizer.scrollToEnd() }, [virtualizer])

// Load older history when near the top
const firstIndex = virtualizer.getVirtualItems()[0]?.index ?? 0
useEffect(() => {
  if (firstIndex <= 10 && hasPreviousPage && !isFetchingPreviousPage) fetchPreviousPage()
}, [firstIndex, hasPreviousPage, isFetchingPreviousPage, fetchPreviousPage])

const showJumpToLatest = !virtualizer.isAtEnd()
// <button onClick={() => virtualizer.scrollToEnd({ behavior: 'smooth' })}>Jump to latest</button>
```

Render rows with `ref={virtualizer.measureElement}` + `data-index` + `transform: translateY(start)` in a normal top-to-bottom container. Keep the "loading older" spinner **outside** the virtualizer, or as an overlay, so it doesn't shift content. The scroller needs a fixed height and `overflow: auto`.

Streaming AI responses: the last message's height grows repeatedly. In end-anchored mode, a pinned viewport stays pinned as the item grows. Keep markdown rendering cheap while streaming (render plain text, then upgrade once the stream finishes) so each chunk doesn't re-parse the whole message.

`maxPages` in a chat: if older pages are trimmed as the user reads far back, they need `getNextPageParam` to page forward again toward the present. Most chats skip `maxPages` and just rely on virtualization for DOM size.

## virtua alternative

virtua keeps position when items are added **at the start** if `shift` is true for that render. It should be false for appends. Derive it from whether the first item changed:

```tsx
const firstId = messages[0]?.id
const prevFirstId = useRef(firstId)
const shift = firstId !== prevFirstId.current // a prepend happened this render
useLayoutEffect(() => { prevFirstId.current = firstId })

<VList ref={ref} data={messages} shift={shift} onScroll={(offset) => {
  if (offset < 200 && hasPreviousPage && !isFetchingPreviousPage) fetchPreviousPage()
  pinned.current = offset - ref.current!.scrollSize + ref.current!.viewportSize >= -1.5 // sub-pixel slack
}}>
  {(m) => <Message key={m.id} message={m} />}
</VList>

// follow appends only when pinned
useEffect(() => { if (pinned.current) ref.current?.scrollToIndex(messages.length - 1, { align: 'end' }) }, [messages.length])
```

The reference implementation is virtua's Chat story (`stories/react/advanced/Chat.stories.tsx` in inokawa/virtua). It also shows `startMargin` for a spinner placed above the list. For reverse scroll in iOS Safari, virtua documents a known limitation: the user must release the scroll before the prepend settles (virtua#473).

## Checklist

- Stable message ids as keys.
- Start at the end after the first data arrives, not before.
- Prepends keep the reading position (test by scrolling up slowly through three history pages).
- Incoming messages don't yank a user who is reading history, and a "Jump to latest" button appears instead.
- A streaming reply stays pinned while it grows.
- Sending a message always scrolls to the end, even if the user had scrolled up.
