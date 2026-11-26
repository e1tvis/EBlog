/* eslint-disable @typescript-eslint/no-explicit-any */
import { unstable_cache } from 'next/cache';
import { prisma } from './prisma';

// ✅ FIX: DB-side "first photo per album-or-its-children" resolution.
// Excludes hidden photos and archived child albums, and prefers direct album
// photos over child album photos before falling back to earliest upload.
async function getFirstPhotoPerAlbumOrChildren(
    albumIds: string[]
): Promise<Map<string, string>> {
    if (albumIds.length === 0) return new Map();

    const rows = await prisma.$queryRaw<{ ownerAlbumId: string; r2Key: string }[]>`
        SELECT DISTINCT ON (owner."ownerAlbumId")
            owner."ownerAlbumId", p."r2Key"
        FROM "Photo" p
        JOIN "Album" a ON a.id = p."albumId"
        JOIN LATERAL (
            SELECT CASE
                WHEN a.id = ANY(${albumIds}::text[]) THEN a.id
                ELSE a."parentId"
            END AS "ownerAlbumId"
        ) owner ON owner."ownerAlbumId" = ANY(${albumIds}::text[])
        WHERE p."visibility" != 'hidden'
          AND a."visibility" != 'archived'
        ORDER BY owner."ownerAlbumId", (a.id = owner."ownerAlbumId") DESC, p."uploadedAt" ASC
    `;

    return new Map(rows.map(r => [r.ownerAlbumId, r.r2Key]));
}

function stripAlbumAccessFields<T extends Record<string, any>>(
    album: T
): Omit<T, 'permissions' | 'roleAccess'> {
    const copy = { ...album };
    delete copy.permissions;
    delete copy.roleAccess;
    return copy;
}

// ─── Gallery Page: Albums with cover photos ─────────────────────────
const getCachedAlbumsBase = (isOwner: boolean, isArchivedView: boolean) => unstable_cache(
    async () => {
        const albums = await prisma.album.findMany({
            where: {
                parentId: null,
                slug: { not: 'vault' },
                visibility: isOwner
                    ? (isArchivedView ? 'archived' : { not: 'archived' })
                    : { not: 'archived' },
            },
            include: {
                permissions: { select: { user: { select: { email: true } } } },
                roleAccess: {
                    select: {
                        role: {
                            select: {
                                name: true,
                                assignments: { select: { userId: true, expiresAt: true, user: { select: { email: true } } } },
                            },
                        },
                    },
                },
            },
            orderBy: { name: 'asc' },
        });

        const coverPhotoIds = albums.map(a => a.coverPhotoId).filter((id): id is string => !!id);
        const explicitCovers = coverPhotoIds.length > 0
            ? await prisma.photo.findMany({ where: { id: { in: coverPhotoIds } }, select: { id: true, r2Key: true } })
            : [];
        const coverMap = new Map(explicitCovers.map(p => [p.id, p.r2Key]));

        const albumsNeedingFallback = albums.filter(a => !a.coverPhotoId || !coverMap.has(a.coverPhotoId));
        const fallbackMap = await getFirstPhotoPerAlbumOrChildren(albumsNeedingFallback.map(a => a.id));

        return albums.map(album => {
            let coverUrl: string | null = null;
            if (album.coverPhotoId && coverMap.has(album.coverPhotoId)) {
                coverUrl = `/api/photos/thumbnail?key=${encodeURIComponent(coverMap.get(album.coverPhotoId)!)}&w=600&v=2`;
            } else if (fallbackMap.has(album.id)) {
                coverUrl = `/api/photos/thumbnail?key=${encodeURIComponent(fallbackMap.get(album.id)!)}&w=600&v=2`;
            }
            return { ...album, coverUrl, createdAt: album.createdAt.toISOString() };
        });
    },
    ['albums-list', String(isOwner), String(isArchivedView)],
    { revalidate: 60, tags: ['albums', 'photos', 'roles'] }
)();

/** Public wrapper: applies per-user permission filtering AFTER the shared cache hit. */
export async function getCachedAlbums(isOwner: boolean, isArchivedView: boolean, userEmail: string | null) {
    const albums = await getCachedAlbumsBase(isOwner, isArchivedView);
    if (isOwner) return albums.map(stripAlbumAccessFields);

    const normalizedEmail = userEmail?.toLowerCase() ?? null;
    const now = new Date();
    return albums
        .filter((a: any) => {
            if (a.visibility === 'public') return true;
            if (normalizedEmail && a.permissions.some((p: any) => p.user?.email?.toLowerCase() === normalizedEmail)) return true;
            const hasImplicitViewerAccess = normalizedEmail && a.roleAccess.some((ra: any) => ra.role.name === 'viewer');
            if (hasImplicitViewerAccess) return true;
            return Boolean(normalizedEmail) && a.roleAccess.some((ra: any) =>
                ra.role.assignments.some((asn: any) =>
                    asn.user?.email?.toLowerCase() === normalizedEmail && (!asn.expiresAt || new Date(asn.expiresAt) > now)
                )
            );
        })
        .map(stripAlbumAccessFields);
}

// ─── Thumbnail: Provider lookup ─────────────────────────────────────
export const getCachedPhotoProvider = (r2Key: string) => unstable_cache(
    async () => {
        const photo = await prisma.photo.findFirst({
            where: { r2Key },
            select: { storageProvider: true },
        });
        return photo?.storageProvider ?? 'r2';
    },
    ['photo-provider', r2Key],
    { revalidate: 300, tags: ['photos'] }
)();

// ─── Albums flat list (for move dialog / admin) ─────────────────────
export const getCachedAllAlbums = unstable_cache(
    async () => {
        return prisma.album.findMany({
            where: { NOT: { AND: [{ parentId: null }, { slug: 'vault' }] } },
            orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
            select: { id: true, name: true, slug: true, parentId: true },
        });
    },
    ['all-albums-flat'],
    { revalidate: 60, tags: ['albums'] }
);

// ─── Admin: Albums flat list (same data, shared cache) ──────────────
export const getCachedAdminAlbums = unstable_cache(
    async () => {
        return prisma.album.findMany({
            where: { NOT: { AND: [{ parentId: null }, { slug: 'vault' }] } },
            select: { id: true, name: true, slug: true, parentId: true },
            orderBy: { name: 'asc' },
        });
    },
    ['admin-albums-flat'],
    { revalidate: 60, tags: ['albums'] }
);

// ─── Admin: Roles with assignments and album access ─────────────────
export const getCachedRoles = unstable_cache(
    async () => {
        // Ensure viewer role exists safely under concurrency
        await prisma.role.upsert({
            where: { name: 'viewer' },
            update: {},
            create: { name: 'viewer', color: '#71717a' },
        });

        const roles = await prisma.role.findMany({
            include: {
                assignments: { include: { user: true } },
                albumAccess: { include: { album: true } },
                exclusions: { include: { photo: true } },
            },
            orderBy: { createdAt: 'asc' },
        });

        // Serialize dates for caching
        return roles.map(role => ({
            ...role,
            createdAt: role.createdAt.toISOString(),
            assignments: role.assignments.map(a => ({
                ...a,
                expiresAt: (a as any).expiresAt ? (a as any).expiresAt.toISOString() : null,
                user: { ...a.user, createdAt: a.user.createdAt.toISOString() },
            })),
            albumAccess: role.albumAccess.map(a => ({
                ...a,
                album: { ...a.album, createdAt: a.album.createdAt.toISOString() },
            })),
            exclusions: role.exclusions.map(e => ({
                ...e,
                photo: {
                    ...e.photo,
                    uploadedAt: e.photo.uploadedAt.toISOString(),
                    takenAt: e.photo.takenAt?.toISOString() ?? null,
                },
            })),
        }));
    },
    ['admin-roles'],
    { revalidate: 60, tags: ['roles'] }
);

// ─── User's display role (for badge) ────────────────────────────────
export const getCachedUserRole = (userEmail: string) => unstable_cache(
    async () => {
        const normalizedEmail = userEmail.toLowerCase();
        // Find the user's role assignments, prefer non-viewer roles that are active
        const assignments = await prisma.roleAssignment.findMany({
            where: {
                user: { email: normalizedEmail },
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            include: { role: { select: { name: true, color: true } } },
            orderBy: { role: { name: 'asc' } },
        });

        if (assignments.length > 0) {
            const preferred = assignments.find(a => a.role.name !== 'viewer') ?? assignments[0];
            return { name: preferred.role.name, color: preferred.role.color };
        }

        // Fallback: check the user's direct role field
        const user = await prisma.user.findUnique({
            where: { email: normalizedEmail },
            select: { role: true },
        });

        return user ? { name: user.role, color: '#71717a' } : null;
    },
    ['user-role', userEmail.toLowerCase()],
    { revalidate: 60, tags: ['roles'] }
)();

// ─── Album Slug Page: Resolve album by path + load data ─────────────
export const getCachedAlbumByPathBase = (slugPath: string[], isOwner: boolean, isArchivedView: boolean) => unstable_cache(
    async () => {
        if (slugPath.length === 0) return null;

        let parentId: string | null = null;
        for (let i = 0; i < slugPath.length - 1; i++) {
            const ancestor: { id: string } | null = await prisma.album.findFirst({
                where: { parentId, slug: slugPath[i] },
                select: { id: true },
            });
            if (!ancestor) return null;
            parentId = ancestor.id;
        }

        const targetSlug = slugPath[slugPath.length - 1];
        const currentAlbum: any = await prisma.album.findFirst({
            where: { parentId, slug: targetSlug },
            include: {
                roleAccess: {
                    include: {
                        role: true,
                    },
                },
                children: {
                    where: isOwner
                        ? (isArchivedView ? { visibility: 'archived' } : { visibility: { not: 'archived' } })
                        : { visibility: { not: 'archived' } },
                    include: {
                        permissions: {
                            select: { user: { select: { email: true } } },
                        },
                        roleAccess: {
                            select: {
                                role: {
                                    select: {
                                        name: true,
                                        assignments: {
                                            select: { expiresAt: true, user: { select: { email: true } } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    orderBy: { name: 'asc' },
                },
                photos: {
                    where: { visibility: { not: 'hidden' } },
                    orderBy: [{ sortOrder: 'asc' }, { uploadedAt: 'desc' }],
                    select: {
                        id: true, filename: true, r2Key: true, fileSize: true,
                        width: true, height: true, uploadedAt: true,
                        takenAt: true, takenAtRaw: true,
                        lat: true, lng: true, unlockPrice: true,
                        storageProvider: true, caption: true, sortOrder: true,
                        mediaType: true, duration: true,
                        likes: { select: { userId: true } },
                        exclusions: { select: { roleId: true } },
                    },
                },
                permissions: { include: { user: true } },
            },
        });

        if (!currentAlbum) return null;

        // Batch-load child album covers
        const childCoverPhotoIds = currentAlbum.children
            .map((c: any) => c.coverPhotoId)
            .filter((id: string | null): id is string => !!id);

        const explicitCovers = childCoverPhotoIds.length > 0
            ? await prisma.photo.findMany({
                where: { id: { in: childCoverPhotoIds } },
                select: { id: true, r2Key: true },
            })
            : [];

        const coverMap = new Map(explicitCovers.map((p: any) => [p.id, p.r2Key]));

        // Fallback covers for children without explicit covers
        const childrenNeedingFallback = currentAlbum.children.filter(
            (c: any) => !c.coverPhotoId || !coverMap.has(c.coverPhotoId)
        );

        const fallbackMap = await getFirstPhotoPerAlbumOrChildren(
            childrenNeedingFallback.map((c: any) => c.id)
        );

        const childAlbumsWithCovers = currentAlbum.children.map((child: any) => {
            let coverUrl: string | null = null;
            if (child.coverPhotoId && coverMap.has(child.coverPhotoId)) {
                coverUrl = `/api/photos/thumbnail?key=${encodeURIComponent(coverMap.get(child.coverPhotoId)!)}&w=400&v=2`;
            } else if (fallbackMap.has(child.id)) {
                coverUrl = `/api/photos/thumbnail?key=${encodeURIComponent(fallbackMap.get(child.id)!)}&w=400&v=2`;
            }
            return {
                ...child,
                coverUrl,
                createdAt: child.createdAt.toISOString(),
            };
        });

        // Serialize dates
        const serializedPhotos = currentAlbum.photos.map((p: any) => ({
            ...p,
            uploadedAt: p.uploadedAt?.toISOString() || '',
            takenAt: p.takenAt?.toISOString() ?? null,
        }));

        const serializedPermissions = currentAlbum.permissions.map((p: any) => ({
            ...p,
            user: p.user ? { ...p.user, createdAt: p.user.createdAt.toISOString() } : null,
        }));

        const serializedRoleAccess = (currentAlbum.roleAccess || []).map((ra: any) => ({
            ...ra,
            role: ra.role ? { ...ra.role, createdAt: ra.role.createdAt?.toISOString?.() ?? ra.role.createdAt } : null,
        }));

        return {
            ...currentAlbum,
            createdAt: currentAlbum.createdAt.toISOString(),
            photos: serializedPhotos,
            permissions: serializedPermissions,
            roleAccess: serializedRoleAccess,
            children: childAlbumsWithCovers,
        };
    },
    ['album-by-path', slugPath.join('/'), String(isOwner), String(isArchivedView)],
    { revalidate: 60, tags: ['albums', 'photos', 'roles'] }
)();

/** Public wrapper: applies per-user child-visibility filtering AFTER the shared cache hit. */
export async function getCachedAlbumByPath(slugPath: string[], isOwner: boolean, isArchivedView: boolean, userEmail: string | null) {
    const album = await getCachedAlbumByPathBase(slugPath, isOwner, isArchivedView);
    if (!album) return null;
    if (isOwner) return album;

    const normalizedEmail = userEmail?.toLowerCase() ?? null;
    const now = new Date();
    const visibleChildren = album.children.filter((c: any) => {
        if (c.visibility === 'public') return true;
        if (normalizedEmail && c.permissions?.some((p: any) => p.user?.email?.toLowerCase() === normalizedEmail)) return true;
        const hasImplicitViewerAccess = normalizedEmail && c.roleAccess?.some((ra: any) => ra.role.name === 'viewer');
        if (hasImplicitViewerAccess) return true;
        return Boolean(normalizedEmail) && c.roleAccess?.some((ra: any) =>
            ra.role.assignments.some((asn: any) =>
                asn.user?.email?.toLowerCase() === normalizedEmail && (!asn.expiresAt || new Date(asn.expiresAt) > now)
            )
        );
    }).map(stripAlbumAccessFields);

    return { ...album, children: visibleChildren };
}

// ─── Recursive photo collection for cover picker ────────────────────
export const getCachedAllPhotosRecursive = (albumId: string) => unstable_cache(
    async () => {
        const allAlbums = await prisma.album.findMany({ select: { id: true, parentId: true } });
        const albumMap = new Map<string, string[]>();
        for (const album of allAlbums) {
            if (album.parentId) {
                const children = albumMap.get(album.parentId) || [];
                children.push(album.id);
                albumMap.set(album.parentId, children);
            }
        }

        const ids: string[] = [albumId];
        const queue = [...(albumMap.get(albumId) || [])];
        while (queue.length > 0) {
            const currentId = queue.shift()!;
            ids.push(currentId);
            const children = albumMap.get(currentId) || [];
            queue.push(...children);
        }

        return prisma.photo.findMany({
            where: {
                albumId: { in: ids },
                visibility: { not: 'hidden' }
            },
            select: { id: true, filename: true, r2Key: true },
            orderBy: [{ uploadedAt: 'desc' }]
        });
    },
    ['all-photos-recursive', albumId],
    { revalidate: 60, tags: ['albums', 'photos'] }
)();
