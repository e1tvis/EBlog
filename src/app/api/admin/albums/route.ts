import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revalidateTag } from "next/cache";
import { getCachedAdminAlbums } from "@/lib/db";
import { isOwner } from "@/lib/auth-utils";

// GET all albums (flat list for admin UI) — cached 60s
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const albums = await getCachedAdminAlbums();
    return NextResponse.json(albums);
}

// POST /api/admin/albums — create a new album
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { name, parentId } = await req.json();
        if (!name?.trim()) {
            return NextResponse.json({ error: "Missing name" }, { status: 400 });
        }

        // Generate a URL-safe slug from the name; fall back if non-ASCII
        const baseSlug = name.trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || `album-${Date.now()}`;

        let slug = baseSlug;
        let suffix = 2;
        let album;
        const MAX_ATTEMPTS = 10;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                album = await prisma.album.create({
                    data: { name: name.trim(), slug, parentId: parentId ?? null },
                });
                break;
            } catch (e: unknown) {
                if ((e as { code?: string })?.code === 'P2002' && attempt < MAX_ATTEMPTS - 1) {
                    slug = `${baseSlug}-${suffix++}`;
                    continue;
                }
                throw e;
            }
        }

        if (!album) {
            return NextResponse.json({ error: "Could not generate unique album slug" }, { status: 409 });
        }

        revalidateTag('albums', { expire: 0 });
        return NextResponse.json(album, { status: 201 });
    } catch (error) {
        console.error("Create album error:", error);
        return NextResponse.json({ error: "Failed to create album" }, { status: 500 });
    }
}
