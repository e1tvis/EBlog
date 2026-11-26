/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createNotification } from "@/lib/notify";
import { isOwner, getOwnerEmailCandidates } from "@/lib/auth-utils";

async function canAccessPhoto(photoId: string, session: any): Promise<boolean> {
    const photo = await prisma.photo.findUnique({
        where: { id: photoId },
        include: {
            exclusions: { select: { roleId: true } },
            unlocks: { include: { user: { select: { email: true } } } },
            album: {
                include: {
                    permissions: { include: { user: { select: { email: true } } } },
                    roleAccess: {
                        include: {
                            role: {
                                include: {
                                    assignments: { include: { user: { select: { email: true } } } },
                                },
                            },
                        },
                    },
                },
            },
        },
    });

    if (!photo) return false;
    if (isOwner(session)) return true;

    const isRootVault = photo.album.parentId === null && photo.album.slug === "vault";
    if (photo.visibility === "hidden" || isRootVault || photo.album.visibility === "archived") {
        return false;
    }
    if (photo.album.visibility === "public") return true;

    const userEmail = session?.user?.email?.toLowerCase();
    if (!userEmail) return false;
    if (photo.album.permissions.some(p => p.user?.email?.toLowerCase() === userEmail)) {
        return true;
    }

    const now = new Date();
    const excludedRoleIds = new Set(photo.exclusions.map(e => e.roleId));
    const activeUnexcludedRoles = photo.album.roleAccess.filter(ra => {
        if (excludedRoleIds.has(ra.roleId)) return false;
        if (ra.role.name === "viewer") return true;
        return ra.role.assignments.some(a =>
            a.user?.email?.toLowerCase() === userEmail && (!a.expiresAt || a.expiresAt > now)
        );
    });

    if (activeUnexcludedRoles.some(ra => !ra.role.isPayAsYouGo)) return true;
    if (activeUnexcludedRoles.some(ra => ra.role.isPayAsYouGo)) {
        return photo.unlocks.some(u => u.user?.email?.toLowerCase() === userEmail);
    }
    return false;
}

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const photoId = searchParams.get('photoId');

    if (!photoId) {
        return NextResponse.json({ error: "Missing photoId" }, { status: 400 });
    }

    try {
        const hasAccess = await canAccessPhoto(photoId, session);
        if (!hasAccess) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const userEmail = session.user?.email?.toLowerCase();
        const caller = userEmail
            ? await prisma.user.findUnique({ where: { email: userEmail }, select: { id: true, role: true } })
            : null;
        const isCallerAdmin = isOwner(session) || caller?.role === 'admin';

        const comments = await prisma.comment.findMany({
            where: { photoId, parentId: null },
            include: {
                user: { select: { id: true, name: true, role: true } },
                replies: {
                    include: { user: { select: { id: true, name: true, role: true } } },
                    orderBy: { createdAt: 'asc' }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        const transformComment = (c: any): any => {
            const canDelete = !c.deletedAt && Boolean(isCallerAdmin || (caller && c.userId === caller.id));
            return {
                ...c,
                body: c.deletedAt ? "[Comment removed]" : c.body,
                canDelete,
                replies: c.replies ? c.replies.map(transformComment) : [],
            };
        };

        return NextResponse.json(comments.map(transformComment));
    } catch (error) {
        console.error("Fetch comments error:", error);
        return NextResponse.json({ error: "Failed to fetch comments" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { photoId, parentId, body } = await req.json();

        if (!photoId || !body?.trim()) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        const userEmail = session.user.email.toLowerCase();
        const user = await prisma.user.findUnique({
            where: { email: userEmail },
            select: { id: true, name: true }
        });

        if (!user) {
            return NextResponse.json({ error: "User not found" }, { status: 404 });
        }

        const hasAccess = await canAccessPhoto(photoId, session);
        if (!hasAccess) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        let parentComment: { id: string; userId: string; photoId: string } | null = null;
        if (parentId) {
            parentComment = await prisma.comment.findUnique({
                where: { id: parentId },
                select: { id: true, userId: true, photoId: true },
            });
            if (!parentComment || parentComment.photoId !== photoId) {
                return NextResponse.json({ error: "Invalid parent comment" }, { status: 400 });
            }
        }

        const comment = await prisma.comment.create({
            data: {
                photoId,
                parentId: parentId || null,
                body: body.trim(),
                userId: user.id
            },
            include: {
                user: { select: { id: true, name: true, role: true } },
                replies: { include: { user: { select: { id: true, name: true, role: true } } } }
            }
        });

        const notifiedUserIds = new Set<string>([user.id]);

        // 1. Notify mentioned users (@username / @name, case-insensitive)
        const mentionRegex = /@([\w.-]+)/g;
        const matches = [...body.matchAll(mentionRegex)];
        const mentionedNames = [...new Set(matches.map((m: RegExpMatchArray) => m[1]?.toLowerCase()).filter(Boolean))];

        if (mentionedNames.length > 0) {
            const mentionedUsers = await prisma.user.findMany({
                where: {
                    OR: mentionedNames.flatMap(token => [
                        { name: { equals: token, mode: 'insensitive' } },
                        { email: { equals: token, mode: 'insensitive' } },
                        { email: { equals: `${token}-git`, mode: 'insensitive' } },
                    ]),
                },
                select: { id: true }
            });

            for (const mUser of mentionedUsers) {
                if (!notifiedUserIds.has(mUser.id)) {
                    notifiedUserIds.add(mUser.id);
                    await createNotification({
                        userId: mUser.id,
                        actorId: user.id,
                        actorName: user.name || "A user",
                        type: "tag",
                        photoId,
                        commentId: comment.id
                    });
                }
            }
        }

        // 2. Notify parent comment author if reply, otherwise notify admins/owner
        if (parentComment) {
            if (!notifiedUserIds.has(parentComment.userId)) {
                notifiedUserIds.add(parentComment.userId);
                await createNotification({
                    userId: parentComment.userId,
                    actorId: user.id,
                    actorName: user.name || "A user",
                    type: "reply",
                    photoId,
                    commentId: comment.id
                });
            }
        } else {
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

            for (const admin of admins) {
                if (!notifiedUserIds.has(admin.id)) {
                    notifiedUserIds.add(admin.id);
                    await createNotification({
                        userId: admin.id,
                        actorId: user.id,
                        actorName: user.name || "A user",
                        type: "comment",
                        photoId,
                        commentId: comment.id
                    });
                }
            }
        }

        return NextResponse.json({ ...comment, canDelete: true });
    } catch (error) {
        console.error("Create comment error:", error);
        return NextResponse.json({ error: "Failed to post comment" }, { status: 500 });
    }
}
