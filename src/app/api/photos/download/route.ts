/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { getStorage, Provider } from "@/lib/storage";
import { prisma } from "@/lib/prisma";
import { isOwner } from "@/lib/auth-utils";

function getAllowedHost(provider: Provider): string | null {
    if (provider === "s3") {
        return "amazonaws.com";
    }
    const endpoint =
        provider === "oracle"
            ? process.env.ORACLE_ENDPOINT
            : provider === "backblaze"
                ? process.env.B2_ENDPOINT
                : process.env.R2_ENDPOINT;
    if (!endpoint) return null;
    try {
        return new URL(endpoint).hostname;
    } catch (error) {
        console.error("Invalid storage endpoint configuration:", endpoint, error);
        return null;
    }
}

function isAllowedRedirectHost(targetHost: string, expectedHost: string): boolean {
    if (targetHost === expectedHost) return true;
    return targetHost.endsWith(`.${expectedHost}`);
}

async function authorizeKeyAccess(
    key: string,
    session: any
): Promise<{ authorized: boolean; provider?: Provider }> {
    const owner = isOwner(session);
    const userEmail = (session?.user?.email as string | undefined)?.toLowerCase();
    const now = new Date();

    // Case 1: key belongs to a Photo (gallery or vault)
    const photo = await prisma.photo.findFirst({
        where: { r2Key: key },
        select: {
            visibility: true,
            storageProvider: true,
            exclusions: { select: { roleId: true } },
            unlocks: { select: { user: { select: { email: true } } } },
            album: {
                select: {
                    parentId: true,
                    slug: true,
                    visibility: true,
                    permissions: { select: { user: { select: { email: true } } } },
                    roleAccess: {
                        select: {
                            roleId: true,
                            role: {
                                select: {
                                    name: true,
                                    isPayAsYouGo: true,
                                    assignments: { select: { expiresAt: true, user: { select: { email: true } } } },
                                },
                            },
                        },
                    },
                },
            },
        },
    });

    if (photo) {
        const resolvedProvider = (photo.storageProvider as Provider) || "r2";
        if (owner) return { authorized: true, provider: resolvedProvider };

        const isRootVault = photo.album.parentId === null && photo.album.slug === "vault";
        if (photo.visibility === "hidden" || isRootVault || photo.album.visibility === "archived") {
            return { authorized: false };
        }
        const album = photo.album;
        if (album.visibility === "public") return { authorized: true, provider: resolvedProvider };
        if (!userEmail) return { authorized: false };
        if (album.permissions.some(p => p.user?.email?.toLowerCase() === userEmail)) {
            return { authorized: true, provider: resolvedProvider };
        }

        const excludedRoleIds = new Set(photo.exclusions.map(e => e.roleId));
        const activeUnexcludedRoles = album.roleAccess.filter(ra => {
            if (excludedRoleIds.has(ra.roleId)) return false;
            if (ra.role.name === "viewer") return true;
            return ra.role.assignments.some(a =>
                a.user?.email?.toLowerCase() === userEmail && (!a.expiresAt || a.expiresAt > now)
            );
        });

        const hasFullAccess = activeUnexcludedRoles.some(ra => !ra.role.isPayAsYouGo);
        if (hasFullAccess) return { authorized: true, provider: resolvedProvider };

        const hasPaygAccess = activeUnexcludedRoles.some(ra => ra.role.isPayAsYouGo);
        if (hasPaygAccess) {
            const isUnlocked = photo.unlocks.some(u => u.user?.email?.toLowerCase() === userEmail);
            return { authorized: isUnlocked, provider: resolvedProvider };
        }

        return { authorized: false };
    }

    // Case 2: key belongs to a chat Message (messenger media)
    const message = await prisma.message.findFirst({
        where: { mediaKey: key },
        select: { expiresAt: true, chat: { select: { userId: true } } },
    });

    if (message) {
        if (message.expiresAt && message.expiresAt <= now) {
            return { authorized: false };
        }
        if (owner) return { authorized: true, provider: "r2" };
        if (!userEmail) return { authorized: false };
        const user = await prisma.user.findUnique({
            where: { email: userEmail },
            select: { id: true, role: true },
        });
        return {
            authorized: Boolean(user && (user.id === message.chat.userId || user.role === "admin")),
            provider: "r2",
        };
    }

    // Case 3: key belongs to a Feed Post media attachment
    const post = await prisma.post.findFirst({
        where: {
            mediaKeys: { has: key },
            archivedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { id: true },
    });
    if (post) {
        return { authorized: Boolean(owner || userEmail), provider: "r2" };
    }

    if (owner) return { authorized: true };
    return { authorized: false };
}

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const key = searchParams.get("key");
    const requestedProvider = (searchParams.get("provider") as Provider) || "r2";
    const direct = searchParams.get("direct");

    if (!key) return NextResponse.json({ error: "Missing key" }, { status: 400 });

    const { authorized, provider: dbProvider } = await authorizeKeyAccess(key, session);
    if (!authorized) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const provider: Provider = dbProvider || requestedProvider;

    try {
        const url = await getStorage(provider).getDownloadUrl(key);
        if (direct === "1" || direct === "true") {
            const expectedHost = getAllowedHost(provider);
            let targetHost: string;
            try {
                targetHost = new URL(url).hostname;
            } catch (error) {
                console.error("Failed to parse signed download URL:", error);
                return NextResponse.json({ error: "Failed to parse download URL from storage provider" }, { status: 500 });
            }
            if (!expectedHost || !isAllowedRedirectHost(targetHost, expectedHost)) {
                return NextResponse.json({ error: "Invalid download URL host" }, { status: 500 });
            }
            return NextResponse.redirect(url);
        }
        return NextResponse.json({ url });
    } catch {
        return NextResponse.json({ error: "Failed to generate URL" }, { status: 500 });
    }
}
