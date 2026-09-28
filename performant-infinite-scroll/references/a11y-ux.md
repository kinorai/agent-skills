# Accessibility and UX

## WAI-ARIA feed pattern

The W3C "feed" pattern is designed for exactly this: a scrollable list of articles where more load as the user reads. See `https://www.w3.org/WAI/ARIA/apg/patterns/feed/`.

```tsx
<section aria-labelledby="feed-title">
  <h2 id="feed-title">Latest posts</h2>
  <div role="feed" aria-busy={isFetchingNextPage} aria-labelledby="feed-title">
    {rows.map((item, i) => (
      <article
        key={item.id}
        aria-posinset={i + 1}
        aria-setsize={hasNextPage ? -1 : items.length} // -1 = total unknown
        aria-labelledby={`post-${item.id}-title`}
        tabIndex={0}
      >
        <h3 id={`post-${item.id}-title`}>{item.title}</h3>
        …
      </article>
    ))}
  </div>
</section>
```

- `aria-busy="true"` while a page is being added, so screen readers don't announce half-updated content. Set it back to false afterwards. That's usually enough, so don't also fire a live-region announcement for every page.
- Each article should be focusable and have an accessible name (its title).
- Optional feed keyboard support: Page Down / Page Up moves focus to the next / previous article. Ctrl+End / Ctrl+Home moves focus out of the feed.

## Focus survives virtualization

- A focused row must stay mounted while it's outside the rendered range (TanStack `rangeExtractor`, see `tanstack-virtual.md` §5, or virtua `keepMounted`).
- **Return focus after back navigation.** Store the id of the item the user opened, and after restoring, focus that row (`preventScroll: true` if you already restored the offset). Otherwise keyboard users start again from the top of the page.

## When not to auto-load

Auto-loading is a progressive enhancement. Keep a manual path:
- A **"Load more" button** in the tail row when the list sits above important content (a footer, related links), in search results where users compare results, and as the fallback when a page load fails.
- **Footers** below an endless feed can't be reached. Move essential links (legal, help, settings) to the header or a sidebar, or stop auto-loading after N pages and show "Load more".
- Offer a "Skip feed" link before long feeds so keyboard users can jump past them.

## Motion and stability

- Only use `behavior: 'smooth'` for programmatic scrolls when `!window.matchMedia('(prefers-reduced-motion: reduce)').matches`.
- Never shift content under the reader. New items at the top become a "N new" pill, and media gets reserved space.
- Skeleton rows should have the same height as real rows. A skeleton that resizes when the row arrives is a layout shift.

## Known limits to state honestly

- **Find in page (Ctrl+F)** can't find rows that aren't mounted. If users need it, provide search in the product, or use the non-virtualized tier with `content-visibility: auto`, which keeps rows in the DOM so find-in-page works.
- **Screen reader browse mode** only sees mounted rows. The feed pattern plus a generous `overscan` lessens this but doesn't remove it.
