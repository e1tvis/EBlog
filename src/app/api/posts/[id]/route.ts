import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isOwner } from "@/lib/auth-utils";
import { getStorage } from "@/lib/storage";

async function resolveRoleIds(
    rawIds: string[] = [],
    rawNames: string[] = []
): Promise<string[]> {
    const combined = [...rawIds, ...rawNames].map(s => s.trim()).filter(Boolean);
    if (combined.length === 0) return [];

    const roles = await prisma.role.findMany({
        select: { id: true, name: true },
    });

    const idSet = new Set<string>();
    const lowerMap = new Map(roles.map(r => [r.name.toLowerCase(), r.id]));
    const existingIds = new Set(roles.map(r => r.id));

    for (const token of combined) {
        if (existingIds.has(token)) {
            idSet.add(token);
        } else {
            const byName = lowerMap.get(token.toLowerCase());
            if (byName) idSet.add(byName);
        }
    }
    return Array.from(idSet);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { id } = await params;
        const {
            body,
            expiresAt,
            includeRoleIds: rawIncludeIds = [],
            excludeRoleIds: rawExcludeIds = [],
            filter,
        } = await req.json();

        const [includeRoleIds, excludeRoleIds] = await Promise.all([
            resolveRoleIds(rawIncludeIds, filter?.includeRoles || []),
            resolveRoleIds(rawExcludeIds, filter?.excludeRoles || []),
        ]);

        const post = await prisma.post.update({
            where: { id },
            data: {
                body,
                expiresAt: expiresAt ? new Date(expiresAt) : null,
                roleFilters: {
                    deleteMany: {},
                    create: [
                        ...includeRoleIds.map((rid: string) => ({ roleId: rid, type: 'include' })),
                        ...excludeRoleIds.map((rid: string) => ({ roleId: rid, type: 'exclude' }))
                    ]
                }
            }
        });

        return NextResponse.json(post);
    } catch (error) {
        console.error("Update post error:", error);
        return NextResponse.json({ error: "Failed to update post" }, { status: 500 });
    }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { id } = await params;

        const post = await prisma.post.findUnique({ where: { id } });

        if (!post) {
            return NextResponse.json({ error: "Post not found" }, { status: 404 });
        }

        if (post.archivedAt) {
            if (post.mediaKeys && post.mediaKeys.length > 0) {
                const storage = getStorage("r2");
                await Promise.allSettled(
                    post.mediaKeys.map(key => storage.deleteObject(key))
                );
            }
            await prisma.post.delete({ where: { id } });
            return NextResponse.json({ deleted: true });
        } else {
            const archivedPost = await prisma.post.update({
                where: { id },
                data: { archivedAt: new Date() }
            });
            return NextResponse.json(archivedPost);
        }
    } catch (error) {
        console.error("Archive/Delete post error:", error);
        return NextResponse.json({ error: "Failed to delete post" }, { status: 500 });
    }
}
