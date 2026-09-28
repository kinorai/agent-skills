# Backend: keyset (cursor) pagination

## Why not offset

`LIMIT 50 OFFSET 500` has two problems for feeds:
1. **Correctness.** Any insert or delete above the current position shifts everything. A new post at the top means the next page repeats the last item of the previous page. A delete means an item is silently skipped.
2. **Cost.** The database still reads and discards the first 500 rows, so deep pages get slower in a straight line.

Keyset pagination says "give me rows after the last one I saw". It stays stable under inserts and is an index range scan at any depth.

## Query shape

The sort must be **total**: add a unique tiebreaker (`id`) to whatever you sort by.

```sql
-- newest first; the cursor is (created_at, id) of the last row of the previous page
SELECT id, created_at, title, excerpt, author_name
FROM posts
WHERE (created_at, id) < ($1, $2)          -- omit this line for the first page
ORDER BY created_at DESC, id DESC
LIMIT $3 + 1;                              -- one extra row tells you whether there's a next page

CREATE INDEX posts_feed_idx ON posts (created_at DESC, id DESC);
```

- Row-value comparison `(a, b) < (x, y)` is index-friendly in PostgreSQL. On engines that don't optimize it, expand it to `created_at < $1 OR (created_at = $1 AND id < $2)`.
- Filters go in the `WHERE` and usually in the index prefix, for example `(author_id, created_at DESC, id DESC)`.
- Fetch `limit + 1` rows. If you got the extra row, drop it and emit a `nextCursor` from the last row you kept, otherwise `nextCursor: null`. Never run a `COUNT(*)` per page. Totals are expensive, and the UI doesn't need them (`aria-setsize="-1"`).

## Cursor encoding

```ts
type Cursor = { t: string; id: string } // t = the exact sort value, as a string

export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url')

export function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString())
    if (typeof c?.t !== 'string' || typeof c?.id !== 'string') throw new Error()
    return c
  } catch {
    throw new InvalidCursorError() // return 400, don't 500
  }
}
```

- **Opaque to clients.** Base64url JSON keeps it URL-safe, and you can change the internals later.
- **Keep full precision.** PostgreSQL `timestamptz` has microseconds, but a JS `Date` has milliseconds. If the cursor goes through `new Date(...)`, rows within the same millisecond get skipped or duplicated. Carry the value as the database's text form (`created_at::text`), or sort by a monotonic id (UUIDv7, ULID, bigserial) and use just that.
- **Validate** the shape and treat a bad cursor as a client error (400), not a crash. If the cursor has to embed filters or permissions, sign it with an HMAC so it can't be tampered with.

## Live data

- **New items while the user scrolls**: don't insert them into loaded pages, since that moves content under the reader. Show a "12 new posts" pill that refetches from the top, or query `WHERE (created_at, id) > (newest_seen)` to prepend on click.
- **Ranked or "hot" feeds** sort by a score that changes, so keyset over a moving score produces duplicates and gaps. Options: snapshot the ranking per session (store the ranked id list with an id, and page through it), or accept small overlaps and **dedupe by id on the client**.
- **Deleted items** vanish from later pages naturally. Loaded pages keep them until a refetch, which is usually fine.

## Response shape

```ts
type FeedPage = {
  items: FeedItem[]           // only what the row renders; truncate text server-side
  nextCursor: string | null   // null = end of feed
}
```

Keep items slim (tens to a few hundred bytes each). Detail fields belong to the detail endpoint. Compression handles repeated key names, so readable keys cost nearly nothing.
