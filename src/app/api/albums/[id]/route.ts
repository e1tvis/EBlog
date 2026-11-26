/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getStorage, Provider } from "@/lib/storage";
import { revalidateTag } from "next/cache";
import { isOwner } from "@/lib/auth-utils";

async function getDescendantAlbumIds(albumId: string): Promise<string[]> {
    const allAlbums = await prisma.album.findMany({
        select: { id: true, parentId: true }
    });

    const albumMap = new Map<string, string[]>();
    for (const album of allAlbums) {
        if (album.parentId) {
            const children = albumMap.get(album.parentId) || [];
            children.push(album.id);
            albumMap.set(album.parentId, children);
        }
    }

    const ids: string[] = [];
    const queue = [...(albumMap.get(albumId) || [])];
    while (queue.length > 0) {
        const currentId = queue.shift()!;
        ids.push(currentId);
        const children = albumMap.get(currentId) || [];
        queue.push(...children);
    }

    return ids;
}

// DELETE /api/albums/[id] — recursively delete album, its sub-albums, and ALL photos inside
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const targetAlbum = await prisma.album.findUnique({ where: { id }, select: { id: true } });
        if (!targetAlbum) {
            return NextResponse.json({ error: "Album not found" }, { status: 404 });
        }

        const descendantIds = await getDescendantAlbumIds(id);
        const allAlbumIds = [id, ...descendantIds];

        const photos = await prisma.photo.findMany({
            where: { albumId: { in: allAlbumIds } },
            select: { id: true, r2Key: true, r2Thumbnail: true, storageProvider: true }
        });

        console.log(`Deleting album ${id}. Found ${descendantIds.length} sub-albums and ${photos.length} photos.`);

        const deletePromises = photos.flatMap(photo => {
            const provider = (photo.storageProvider as Provider) || "r2";
            const storage = getStorage(provider);
            const tasks = [
                storage.deleteObject(photo.r2Key).catch(e =>
                    console.error(`Failed to delete ${provider} file ${photo.r2Key}:`, e)
                ),
            ];
            if (photo.r2Thumbnail) {
                tasks.push(
                    storage.deleteObject(photo.r2Thumbnail).catch(e =>
                        console.error(`Failed to delete ${provider} thumbnail ${photo.r2Thumbnail}:`, e)
                    )
                );
            }
            return tasks;
        });

        await Promise.all(deletePromises);

        const photoIds = photos.map(p => p.id);

        await prisma.$transaction([
            ...(photoIds.length > 0
                ? [
                    prisma.album.updateMany({
                        where: { coverPhotoId: { in: photoIds } },
                        data: { coverPhotoId: null },
                    }),
                ]
                : []),
            prisma.photo.deleteMany({
                where: { albumId: { in: allAlbumIds } }
            }),
            prisma.albumPermission.deleteMany({
                where: { albumId: { in: allAlbumIds } }
            }),
            prisma.roleAlbumAccess.deleteMany({
                where: { albumId: { in: allAlbumIds } }
            }),
            prisma.album.deleteMany({
                where: { id: { in: allAlbumIds } }
            }),
        ]);

        revalidateTag('albums', { expire: 0 });
        revalidateTag('photos', { expire: 0 });
        return NextResponse.json({ success: true, count: photos.length, albumsDeleted: allAlbumIds.length });
    } catch (err: any) {
        console.error("Recursive delete album error:", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// PATCH /api/albums/[id] — update album details (name, visibility)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const body = await req.json();
        const { name, visibility } = body;

        const updateData: Record<string, unknown> = {};
        if (name !== undefined) {
            if (typeof name !== "string" || !name.trim()) {
                return NextResponse.json({ error: "Album name cannot be empty" }, { status: 400 });
            }
            updateData.name = name.trim();
        }
        if (visibility !== undefined) updateData.visibility = visibility;

        const album = await prisma.album.update({
            where: { id },
            data: updateData
        });

        revalidateTag('albums', { expire: 0 });
        return NextResponse.json({ success: true, album });
    } catch (err: any) {
        console.error("Update album error:", err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
