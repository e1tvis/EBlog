import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";

export const maxDuration = 60;

export async function GET(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const secret = process.env.CRON_SECRET;

    if (!secret || authHeader !== `Bearer ${secret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const now = new Date();
        const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        let archivedCount = 0;
        let deletedPostsCount = 0;
        let deletedMessagesCount = 0;

        // 1. Archive expired posts
        const expiredPosts = await prisma.post.updateMany({
            where: {
                expiresAt: { lte: now },
                archivedAt: null,
            },
            data: { archivedAt: now }
        });
        archivedCount = expiredPosts.count;

        const storage = getStorage("r2");

        // 2. Hard delete posts archived > 14 days ago (and clean up their media files)
        const postsToDelete = await prisma.post.findMany({
            where: { archivedAt: { lte: fourteenDaysAgo } },
            select: { id: true, mediaKeys: true },
        });
        if (postsToDelete.length > 0) {
            const postMediaKeys = postsToDelete.flatMap(p => p.mediaKeys || []).filter(Boolean);
            if (postMediaKeys.length > 0) {
                await Promise.allSettled(postMediaKeys.map(key => storage.deleteObject(key)));
            }
            const oldPosts = await prisma.post.deleteMany({
                where: { id: { in: postsToDelete.map(p => p.id) } }
            });
            deletedPostsCount = oldPosts.count;
        }

        // 3. Hard delete expired messages (and clean up their media files)
        const messagesToDelete = await prisma.message.findMany({
            where: { expiresAt: { lte: now } },
            select: { id: true, mediaKey: true },
        });
        if (messagesToDelete.length > 0) {
            const msgMediaKeys = messagesToDelete.map(m => m.mediaKey).filter((k): k is string => Boolean(k));
            if (msgMediaKeys.length > 0) {
                await Promise.allSettled(msgMediaKeys.map(key => storage.deleteObject(key)));
            }
            const oldMessages = await prisma.message.deleteMany({
                where: { id: { in: messagesToDelete.map(m => m.id) } }
            });
            deletedMessagesCount = oldMessages.count;
        }

        console.log(`[cron/cleanup] Run complete: Archived ${archivedCount} posts, Deleted ${deletedPostsCount} posts, Deleted ${deletedMessagesCount} messages.`);

        return NextResponse.json({
            success: true,
            archivedCount,
            deletedPostsCount,
            deletedMessagesCount
        });
    } catch (error) {
        console.error("[cron/cleanup] Error:", error);
        return NextResponse.json({ error: "Cron execution failed" }, { status: 500 });
    }
}
