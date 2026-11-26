import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getStorage, Provider } from "@/lib/storage";
import { revalidateTag } from "next/cache";
import { isOwner } from "@/lib/auth-utils";

// DELETE /api/photos/[id] — delete a photo and its cached thumbnail from storage and database
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const photo = await prisma.photo.findUnique({
            where: { id },
            select: { id: true, r2Key: true, r2Thumbnail: true, storageProvider: true }
        });

        if (!photo) {
            return NextResponse.json({ error: "Photo not found" }, { status: 404 });
        }

        const provider = (photo.storageProvider as Provider) || "r2";
        const storage = getStorage(provider);

        try {
            await storage.deleteObject(photo.r2Key);
        } catch (storageErr) {
            console.error(`Failed to delete file from ${provider}:`, storageErr);
        }

        if (photo.r2Thumbnail) {
            try {
                await storage.deleteObject(photo.r2Thumbnail);
            } catch (thumbErr) {
                console.error(`Failed to delete thumbnail from ${provider}:`, thumbErr);
            }
        }

        await prisma.$transaction([
            prisma.album.updateMany({
                where: { coverPhotoId: id },
                data: { coverPhotoId: null },
            }),
            prisma.photo.delete({ where: { id } }),
        ]);

        revalidateTag('photos', { expire: 0 });
        revalidateTag('albums', { expire: 0 });
        return NextResponse.json({ success: true, id });
    } catch (err: unknown) {
        console.error("Delete photo error:", err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Failed to delete photo" },
            { status: 500 }
        );
    }
}
