import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revalidateTag } from "next/cache";
import { isOwner } from "@/lib/auth-utils";

// POST grant a role access to album(s) — supports single albumId or batch albumIds
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { roleId, albumId, albumIds } = await req.json();
        const ids: string[] = albumIds || (albumId ? [albumId] : []);
        if (!roleId || ids.length === 0) {
            return NextResponse.json({ error: "roleId and albumId(s) required" }, { status: 400 });
        }

        await prisma.roleAlbumAccess.createMany({
            data: ids.map((id: string) => ({ roleId, albumId: id })),
            skipDuplicates: true,
        });

        revalidateTag('roles', { expire: 0 });
        revalidateTag('albums', { expire: 0 });
        return NextResponse.json({ success: true, count: ids.length });
    } catch (error) {
        console.error("Grant role album access error:", error);
        return NextResponse.json({ error: "Failed to grant album access" }, { status: 500 });
    }
}

// DELETE revoke a role's access to an album
export async function DELETE(req: Request) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { id } = await req.json();
        if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

        await prisma.roleAlbumAccess.deleteMany({ where: { id } });

        revalidateTag('roles', { expire: 0 });
        revalidateTag('albums', { expire: 0 });
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Revoke role album access error:", error);
        return NextResponse.json({ error: "Failed to revoke album access" }, { status: 500 });
    }
}
