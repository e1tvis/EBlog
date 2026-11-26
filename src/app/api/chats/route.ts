import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isOwner } from "@/lib/auth-utils";

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userEmail = session.user.email.toLowerCase();

    try {
        await prisma.user.updateMany({
            where: { email: userEmail },
            data: { lastSeen: new Date() }
        });

        // Admins get all chats; regular users get only their own
        if (isOwner(session)) {
            const chats = await prisma.chat.findMany({
                include: {
                    user: { select: { id: true, name: true, email: true, lastSeen: true } },
                    messages: {
                        orderBy: { createdAt: 'desc' },
                        take: 1
                    },
                },
                orderBy: { createdAt: 'desc' },
            });
            return NextResponse.json(chats);
        } else {
            const user = await prisma.user.findUnique({
                where: { email: userEmail },
                select: { id: true, role: true },
            });
            if (!user) return NextResponse.json([]);

            if (user.role === 'admin') {
                const chats = await prisma.chat.findMany({
                    include: {
                        user: { select: { id: true, name: true, email: true, lastSeen: true } },
                        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
                    },
                    orderBy: { createdAt: 'desc' },
                });
                return NextResponse.json(chats);
            }

            const chat = await prisma.chat.findUnique({
                where: { userId: user.id },
                include: {
                    user: { select: { id: true, name: true, email: true, lastSeen: true } },
                    messages: { orderBy: { createdAt: 'desc' }, take: 1 },
                },
            });
            return NextResponse.json(chat ? [chat] : []);
        }
    } catch (error) {
        console.error("Fetch chats error:", error);
        return NextResponse.json({ error: "Failed to fetch chats" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        let targetEmail = session.user.email.toLowerCase();
        if (isOwner(session)) {
            const body = await req.json().catch(() => ({}));
            if (body.targetUserId) {
                const targetUser = await prisma.user.findUnique({
                    where: { id: body.targetUserId },
                    select: { id: true, email: true },
                });
                if (!targetUser || !targetUser.email) {
                    return NextResponse.json({ error: "User not found" }, { status: 404 });
                }
                targetEmail = targetUser.email.toLowerCase();
            }
        }

        const user = await prisma.user.findUnique({
            where: { email: targetEmail },
            select: { id: true }
        });

        if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

        let chat = await prisma.chat.findUnique({
            where: { userId: user.id },
            include: { user: { select: { id: true, name: true, email: true, lastSeen: true } } }
        });

        if (!chat) {
            chat = await prisma.chat.create({
                data: { userId: user.id },
                include: { user: { select: { id: true, name: true, email: true, lastSeen: true } } }
            });
        }

        return NextResponse.json(chat);
    } catch (error) {
        console.error("Create chat error:", error);
        return NextResponse.json({ error: "Failed to create or get chat" }, { status: 500 });
    }
}
