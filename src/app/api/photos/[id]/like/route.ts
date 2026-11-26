import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isOwner } from "@/lib/auth-utils";
import { revalidateTag } from "next/cache";

// POST /api/photos/[id]/like — toggle like for authenticated user
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: photoId } = await params;
    const userEmail = session.user.email.toLowerCase();

    try {
        const [user, photo] = await Promise.all([
            prisma.user.findUnique({ where: { email: userEmail } }),
            prisma.photo.findUnique({
                where: { id: photoId },
                include: {
                    exclusions: { select: { roleId: true } },
                    unlocks: { select: { userId: true } },
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
            }),
        ]);

        if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
        if (!photo) return NextResponse.json({ error: "Photo not found" }, { status: 404 });

        if (!isOwner(session)) {
            const isRootVault = photo.album.parentId === null && photo.album.slug === "vault";
            if (photo.visibility === "hidden" || isRootVault || photo.album.visibility === "archived") {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
            const now = new Date();
            const isPublic = photo.album.visibility === "public";
            const hasDirectPerm = photo.album.permissions.some(p => p.user?.email?.toLowerCase() === userEmail);

            const excludedRoleIds = new Set(photo.exclusions.map(e => e.roleId));
            const activeUnexcludedRoles = photo.album.roleAccess.filter(ra => {
                if (excludedRoleIds.has(ra.roleId)) return false;
                if (ra.role.name === "viewer") return true;
                return ra.role.assignments.some(a =>
                    a.user?.email?.toLowerCase() === userEmail && (!a.expiresAt || a.expiresAt > now)
                );
            });

            const hasFullRole = activeUnexcludedRoles.some(ra => !ra.role.isPayAsYouGo);
            const hasPaygUnlocked =
                activeUnexcludedRoles.some(ra => ra.role.isPayAsYouGo) &&
                photo.unlocks.some(u => u.userId === user.id);

            if (!isPublic && !hasDirectPerm && !hasFullRole && !hasPaygUnlocked) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }
        }

        const existing = await prisma.photoLike.findUnique({
            where: { photoId_userId: { photoId, userId: user.id } },
        });

        if (existing) {
            await prisma.photoLike.delete({ where: { id: existing.id } });
        } else {
            await prisma.photoLike.create({ data: { photoId, userId: user.id } });
        }

        revalidateTag('photos', { expire: 0 });
        const count = await prisma.photoLike.count({ where: { photoId } });
        return NextResponse.json({ liked: !existing, count });
    } catch (error) {
        console.error("Photo like toggle error:", error);
        return NextResponse.json({ error: "Failed to toggle like" }, { status: 500 });
    }
}
