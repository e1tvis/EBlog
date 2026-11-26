import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email: session.user.email.toLowerCase() },
            select: { id: true }
        });

        if (!user) {
            return NextResponse.json([]);
        }

        const notifications = await prisma.notification.findMany({
            where: { userId: user.id },
            orderBy: [{ read: 'asc' }, { createdAt: 'desc' }],
            take: 20
        });

        // Resolve album slug paths for photo-linked notifications so clicking navigates cleanly
        const photoIds = [...new Set(notifications.map(n => n.photoId).filter((id): id is string => Boolean(id)))];
        const photoPathMap = new Map<string, string>();

        if (photoIds.length > 0) {
            const [photos, allAlbums] = await Promise.all([
                prisma.photo.findMany({
                    where: { id: { in: photoIds } },
                    select: { id: true, albumId: true },
                }),
                prisma.album.findMany({
                    select: { id: true, slug: true, parentId: true },
                }),
            ]);

            const albumMap = new Map(allAlbums.map(a => [a.id, a]));
            for (const p of photos) {
                const parts: string[] = [];
                let cur = albumMap.get(p.albumId);
                let depth = 0;
                while (cur && depth < 20) {
                    parts.unshift(cur.slug);
                    cur = cur.parentId ? albumMap.get(cur.parentId) : undefined;
                    depth++;
                }
                if (parts.length === 1 && parts[0] === 'vault') {
                    photoPathMap.set(p.id, '/vault');
                } else if (parts.length > 0) {
                    photoPathMap.set(p.id, `/gallery/${parts.join('/')}`);
                }
            }
        }

        const enriched = notifications.map(n => ({
            ...n,
            targetUrl: n.photoId ? (photoPathMap.get(n.photoId) ?? '/gallery') : null,
        }));

        return NextResponse.json(enriched);
    } catch (error) {
        console.error("Fetch notifications error:", error);
        return NextResponse.json({ error: "Failed to fetch notifications" }, { status: 500 });
    }
}

export async function PATCH(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { id, markAll } = await req.json();

        const user = await prisma.user.findUnique({
            where: { email: session.user.email.toLowerCase() },
            select: { id: true }
        });

        if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

        if (markAll) {
            await prisma.notification.updateMany({
                where: { userId: user.id, read: false },
                data: { read: true }
            });
        } else if (id) {
            await prisma.notification.updateMany({
                where: { id, userId: user.id },
                data: { read: true }
            });
        } else {
            return NextResponse.json({ error: "No action provided" }, { status: 400 });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Update notification error:", error);
        return NextResponse.json({ error: "Failed to mark notifications read" }, { status: 500 });
    }
}
