---
files:
  - "src/app/api/**/*.ts"
  - "src/lib/db.ts"
  - "src/lib/auth-utils.ts"
  - "middleware.ts"
---

# API routes enforce authorization themselves

`middleware.ts` only gates `/gallery/:path*`. Nothing in front of `src/app/api/**` checks
the user, so every route handler must decide on its own who may call it and which
records they may touch. Being logged in is not the same as being allowed: albums,
photos and chat media are private by default, and storage keys (`r2Key`, `mediaKey`)
are deterministic and guessable.

A change breaks this requirement when it:

- adds or changes a route handler (`GET`, `POST`, `PATCH`, `DELETE`, ...) that reads or
  writes data, or issues signed storage URLs, without first resolving the session with
  `getServerSession(authOptions)` (or `getSession()`) and rejecting callers who may not
  use it. Cron routes check `Authorization: Bearer ${CRON_SECRET}` instead.
- lets a mutation of site content (albums, photos, posts, roles, sync, storage, admin
  routes) run for anyone but the owner — these must gate on `isOwner(session)` from
  `@/lib/auth-utils`, not merely on `session` being present.
- reads or returns a record identified by a client-supplied `id`, `photoId`, `albumId`
  or storage `key` while checking only `if (!session)`. The record must be looked up
  and its access rules applied: owner, or `album.visibility === "public"`, or a
  matching `album.permissions` entry, or `album.roleAccess` with a role named
  `"viewer"`, or a role assignment for this user whose `expiresAt` is unset or in the
  future; photos with `visibility === "hidden"` are owner-only. Chat messages and
  their media belong only to the owner and the chat's `userId`.
- widens these rules, e.g. treating any `userEmail` as implicit viewer access,
  dropping the `expiresAt` check, or putting per-user results into a cache shared
  across users (`getCachedAlbums` / `getCachedAlbumByPath` in `src/lib/db.ts` must keep
  filtering per viewer after the shared fetch).
- grants paid or locked access (e.g. creating a `PhotoUnlock`) without verifying the
  payment server-side.
- calls an async auth helper such as `withAuth(...)` or `getServerSession(...)` without
  `await` and then tests the result, which is always truthy or never a `NextResponse`.

Unknown or unauthorized records should return 404 (or 401/403), never a URL or data.

These mistakes have already shipped here: `/api/photos/download` signed any storage
key for any logged-in user, `getCachedAlbums` showed every private album to every
logged-in user, the middleware forgot to `await withAuth()` and let every request
through, and `/api/photos/[id]/unlock` unlocked paid photos with no payment check.

Incorrect — any logged-in user gets a URL for any object:

```ts
const session = await getServerSession(authOptions);
if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const url = await getR2DownloadUrl(key);
```

Correct — resolve the key to its record and apply the same rules as the gallery:

```ts
const session = await getServerSession(authOptions);
if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
if (!(await authorizeKeyAccess(key, session))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
}
const url = await getR2DownloadUrl(key);
```

Incorrect — implicit viewer access for every authenticated user:

```ts
if (userEmail) return true;
```

Correct:

```ts
const hasImplicitViewerAccess = userEmail && a.roleAccess.some((ra: any) => ra.role.name === 'viewer');
if (hasImplicitViewerAccess) return true;
```
