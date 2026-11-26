import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revalidateTag } from "next/cache";
import { isOwner } from "@/lib/auth-utils";

/**
 * Recursively collects IDs of albums that are entirely empty
 * (no photos in themselves AND none in any descendant).
 */
function collectEmptyAlbumIds(
    parentId: string | null,
    allAlbums: { id: string; parentId: string | null }[],
    photoCounts: Map<string, number>
): string[] {
    const children = allAlbums.filter(a => a.parentId === parentId);
    const emptyIds: string[] = [];

    for (const child of children) {
        const descendantEmpty = collectEmptyAlbumIds(child.id, allAlbums, photoCounts);
        const photoCount = photoCounts.get(child.id) || 0;
        const childIds = allAlbums.filter(a => a.parentId === child.id).map(a => a.id);
        const allChildrenEmpty = childIds.every(id => descendantEmpty.includes(id));

        if (photoCount === 0 && allChildrenEmpty) {
            emptyIds.push(...descendantEmpty.filter(id => !emptyIds.includes(id)));
            emptyIds.push(child.id);
        }
    }

    return emptyIds;
}

// DELETE /api/admin/albums/empty — remove all recursively empty albums
export async function DELETE() {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const allAlbums = await prisma.album.findMany({
            where: { NOT: { AND: [{ parentId: null }, { slug: 'vault' }] } },
            select: { id: true, parentId: true },
        });
        const photoCountsRaw = await prisma.photo.groupBy({
            by: ['albumId'],
            _count: { id: true }
        });
        const photoCounts = new Map<string, number>(photoCountsRaw.map(p => [p.albumId, p._count.id]));
        const emptyIds = collectEmptyAlbumIds(null, allAlbums, photoCounts);

        if (emptyIds.length === 0) {
            return NextResponse.json({ deleted: 0, message: "No empty albums found" });
        }

        const [, , deleteRes] = await prisma.$transaction([
            prisma.albumPermission.deleteMany({ where: { albumId: { in: emptyIds } } }),
            prisma.roleAlbumAccess.deleteMany({ where: { albumId: { in: emptyIds } } }),
            prisma.album.deleteMany({ where: { id: { in: emptyIds } } }),
        ]);

        revalidateTag('albums', { expire: 0 });
        return NextResponse.json({ deleted: deleteRes.count, ids: emptyIds });
    } catch (err: unknown) {
        console.error("Delete empty albums error:", err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Failed to delete empty albums" },
            { status: 500 }
        );
    }
}
