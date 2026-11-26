import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createBulkNotifications } from "@/lib/notify";
import { isOwner, getOwnerEmailCandidates } from "@/lib/auth-utils";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { id } = await params;
        const userEmail = session.user.email.toLowerCase();
        const user = await prisma.user.findUnique({
            where: { email: userEmail },
            select: { id: true, name: true }
        });

        if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

        const now = new Date();
        const post = await prisma.post.findUnique({ where: { id } });
        if (!post || post.archivedAt || (post.expiresAt && post.expiresAt <= now)) {
            return NextResponse.json({ error: "Post not found" }, { status: 404 });
        }

        const existing = await prisma.postLike.findUnique({
            where: { postId_userId: { postId: id, userId: user.id } },
        });

        if (!existing) {
            await prisma.postLike.create({
                data: { postId: id, userId: user.id }
            });

            if (!isOwner(session)) {
                const ownerEmails = getOwnerEmailCandidates();
                const admins = await prisma.user.findMany({
                    where: {
                        OR: [
                            { role: 'admin' },
                            ...(ownerEmails.length > 0 ? [{ email: { in: ownerEmails } }] : []),
                        ],
                    },
                    select: { id: true },
                });

                await createBulkNotifications(
                    admins.map(a => a.id),
                    {
                        actorId: user.id,
                        actorName: user.name || "A user",
                        type: 'like',
                        postId: id,
                    }
                );
            }
        }

        return NextResponse.json({ success: true, liked: true });
    } catch {
        return NextResponse.json({ error: "Failed to like post" }, { status: 500 });
    }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { id } = await params;
        const userEmail = session.user.email.toLowerCase();
        const user = await prisma.user.findUnique({
            where: { email: userEmail },
            select: { id: true }
        });

        if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

        await prisma.postLike.deleteMany({
            where: {
                postId: id,
                userId: user.id,
            }
        });

        return NextResponse.json({ success: true, liked: false });
    } catch {
        return NextResponse.json({ error: "Failed to unlike post" }, { status: 500 });
    }
}
