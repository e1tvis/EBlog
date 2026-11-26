import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getStorage, Provider } from "@/lib/storage";
import { revalidateTag } from "next/cache";
import { isOwner } from "@/lib/auth-utils";
import sharp from "sharp";

export const maxDuration = 30;

/**
 * POST /api/photos/[id]/set-thumbnail
 * Owner uploads a captured video frame (base64 JPEG) to use as the thumbnail.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    try {
        const { frameData } = await req.json();
        if (!frameData) {
            return NextResponse.json({ error: "Missing frameData" }, { status: 400 });
        }

        const photo = await prisma.photo.findUnique({
            where: { id },
            select: { id: true, r2Key: true, storageProvider: true },
        });
        if (!photo) {
            return NextResponse.json({ error: "Photo not found" }, { status: 404 });
        }

        const base64Data = frameData.replace(/^data:image\/\w+;base64,/, "");
        const frameBuffer = Buffer.from(base64Data, "base64");

        const thumbnailBuffer = await sharp(frameBuffer, {
            limitInputPixels: false,
            failOn: "none",
        })
            .resize({ width: 600, withoutEnlargement: true })
            .jpeg({ quality: 92, progressive: true, mozjpeg: true })
            .toBuffer();

        const thumbKey = `thumbs/600/${photo.r2Key}.jpg`;
        const provider = (photo.storageProvider as Provider) || "r2";
        await getStorage(provider).putObject(thumbKey, new Uint8Array(thumbnailBuffer), "image/jpeg");

        await prisma.photo.update({
            where: { id },
            data: { r2Thumbnail: thumbKey },
        });

        revalidateTag("photos", { expire: 0 });
        return NextResponse.json({ success: true, thumbnailKey: thumbKey });
    } catch (error: unknown) {
        console.error("Set thumbnail error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Failed to set thumbnail" },
            { status: 500 }
        );
    }
}
