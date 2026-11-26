import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createBulkNotifications } from "@/lib/notify";
import { isOwner } from "@/lib/auth-utils";

async function resolveRoleIds(
    rawIds: string[] = [],
    rawNames: string[] = []
): Promise<string[]> {
    const combined = [...rawIds, ...rawNames].map(s => s.trim()).filter(Boolean);
    if (combined.length === 0) return [];

    // Ensure built-in viewer role exists so "viewer" in include/exclude resolves cleanly
    await prisma.role.upsert({
        where: { name: 'viewer' },
        update: {},
        create: { name: 'viewer', color: '#71717a' },
    });

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

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userEmail = session.user.email.toLowerCase();
    const now = new Date();

    try {
        const [user, roleAssignments, viewerRole] = await Promise.all([
            prisma.user.findUnique({
                where: { email: userEmail },
                select: { id: true, role: true },
            }),
            prisma.roleAssignment.findMany({
                where: {
                    user: { email: userEmail },
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                },
                select: { roleId: true },
            }),
            prisma.role.findUnique({
                where: { name: 'viewer' },
                select: { id: true },
            }),
        ]);

        if (!user && !isOwner(session)) {
            return NextResponse.json({ error: "User not found" }, { status: 404 });
        }

        const isAdmin = isOwner(session) || user?.role === 'admin';

        let posts;

        if (isAdmin) {
            posts = await prisma.post.findMany({
                where: {
                    archivedAt: null,
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                },
                include: {
                    roleFilters: { include: { role: true } },
                    likes: true,
                    _count: { select: { comments: true } },
                },
                orderBy: { createdAt: 'desc' },
            });
        } else {
            const assignedRoleIds = roleAssignments.map(a => a.roleId);

            let namedRoleId: string | null = null;
            if (user?.role && user.role !== 'viewer') {
                const namedRole = await prisma.role.findUnique({
                    where: { name: user.role },
                    select: { id: true },
                });
                namedRoleId = namedRole?.id ?? null;
            }

            // Every authenticated user implicitly holds the built-in 'viewer' role
            const roleIds = [...new Set([
                ...assignedRoleIds,
                ...(namedRoleId ? [namedRoleId] : []),
                ...(viewerRole ? [viewerRole.id] : []),
            ])];

            posts = await prisma.post.findMany({
                where: {
                    archivedAt: null,
                    AND: [
                        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
                        {
                            NOT: {
                                roleFilters: {
                                    some: { type: 'exclude', roleId: { in: roleIds } },
                                },
                            },
                        },
                        {
                            OR: [
                                { roleFilters: { none: { type: 'include' } } },
                                { roleFilters: { some: { type: 'include', roleId: { in: roleIds } } } },
                            ],
                        },
                    ],
                },
                include: {
                    likes: true,
                    _count: { select: { comments: true } },
                },
                orderBy: { createdAt: 'desc' },
            });
        }

        return NextResponse.json(posts);
    } catch (error) {
        console.error("Fetch posts error:", error);
        return NextResponse.json({ error: "Failed to fetch posts" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized admin only" }, { status: 401 });
    }

    try {
        const payload = await req.json();
        const {
            body,
            mediaKeys,
            expiresAt,
            includeRoleIds: rawIncludeIds = [],
            excludeRoleIds: rawExcludeIds = [],
            filter,
        } = payload;

        if (!body || !String(body).trim()) {
            return NextResponse.json({ error: "Body is required" }, { status: 400 });
        }

        const [includeRoleIds, excludeRoleIds, viewerRole] = await Promise.all([
            resolveRoleIds(rawIncludeIds, filter?.includeRoles || []),
            resolveRoleIds(rawExcludeIds, filter?.excludeRoles || []),
            prisma.role.findUnique({ where: { name: 'viewer' }, select: { id: true } }),
        ]);

        const userEmail = session!.user!.email!.toLowerCase();
        const adminUser = await prisma.user.findUnique({
            where: { email: userEmail },
            select: { id: true, name: true },
        });

        const post = await prisma.post.create({
            data: {
                body,
                mediaKeys: mediaKeys || [],
                expiresAt: expiresAt ? new Date(expiresAt) : null,
                roleFilters: {
                    create: [
                        ...includeRoleIds.map((id: string) => ({ roleId: id, type: 'include' })),
                        ...excludeRoleIds.map((id: string) => ({ roleId: id, type: 'exclude' })),
                    ],
                },
            },
            include: {
                roleFilters: { include: { role: true } },
                likes: true,
                _count: { select: { comments: true } },
            },
        });

        const viewerExcluded = Boolean(viewerRole && excludeRoleIds.includes(viewerRole.id));
        const viewerIncluded = Boolean(viewerRole && includeRoleIds.includes(viewerRole.id));

        let userIdsToNotify: string[] = [];
        if (!viewerExcluded) {
            const now = new Date();
            const applicableUsers = await prisma.user.findMany({
                where: {
                    AND: [
                        excludeRoleIds.length > 0
                            ? {
                                NOT: {
                                    roleAssignments: {
                                        some: {
                                            roleId: { in: excludeRoleIds },
                                            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                                        },
                                    },
                                },
                            }
                            : {},
                        includeRoleIds.length > 0 && !viewerIncluded
                            ? {
                                roleAssignments: {
                                    some: {
                                        roleId: { in: includeRoleIds },
                                        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                                    },
                                },
                            }
                            : {},
                    ],
                },
                select: { id: true },
            });
            userIdsToNotify = applicableUsers.map(u => u.id);
        }

        if (userIdsToNotify.length > 0 && adminUser) {
            await createBulkNotifications(userIdsToNotify, {
                actorId: adminUser.id,
                actorName: adminUser.name || 'Admin',
                type: 'post',
                postId: post.id,
            });
        }

        return NextResponse.json(post);
    } catch (error) {
        console.error("Create post error:", error);
        return NextResponse.json({ error: "Failed to create post" }, { status: 500 });
    }
}
