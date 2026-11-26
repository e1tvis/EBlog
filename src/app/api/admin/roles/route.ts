import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revalidateTag } from "next/cache";
import { getCachedRoles } from "@/lib/db";
import { isOwner } from "@/lib/auth-utils";

// GET all roles with assignments and album access
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const roles = await getCachedRoles();
    return NextResponse.json(roles);
}

// POST create a new role
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { name, color, durationDays, isPayAsYouGo, photoUnlockPrice, blurPreviewCount } = await req.json();
        if (!name || !String(name).trim()) {
            return NextResponse.json({ error: "Name required" }, { status: 400 });
        }

        const parsedDuration = durationDays ? parseInt(String(durationDays), 10) : null;
        const parsedPrice = photoUnlockPrice ? parseFloat(String(photoUnlockPrice)) : null;
        const parsedPreview = blurPreviewCount ? parseInt(String(blurPreviewCount), 10) : null;

        const role = await prisma.role.create({
            data: {
                name: String(name).trim().toLowerCase(),
                color: color || "#6366f1",
                durationDays: parsedDuration !== null && !Number.isNaN(parsedDuration) ? parsedDuration : null,
                isPayAsYouGo: Boolean(isPayAsYouGo),
                photoUnlockPrice: parsedPrice !== null && !Number.isNaN(parsedPrice) ? parsedPrice : null,
                blurPreviewCount: parsedPreview !== null && !Number.isNaN(parsedPreview) ? parsedPreview : null,
            },
        });

        revalidateTag('roles', { expire: 0 });
        return NextResponse.json(role);
    } catch (error: unknown) {
        if ((error as { code?: string })?.code === 'P2002') {
            return NextResponse.json({ error: "A role with that name already exists" }, { status: 409 });
        }
        console.error("Create role error:", error);
        return NextResponse.json({ error: "Failed to create role" }, { status: 500 });
    }
}

// DELETE a role (but never the viewer role)
export async function DELETE(req: Request) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { id } = await req.json();
        if (!id) return NextResponse.json({ error: "Role id required" }, { status: 400 });

        const role = await prisma.role.findUnique({ where: { id } });
        if (!role) return NextResponse.json({ error: "Role not found" }, { status: 404 });
        if (role.name === 'viewer') {
            return NextResponse.json({ error: "Cannot delete the built-in viewer role" }, { status: 400 });
        }

        await prisma.role.delete({ where: { id } });

        revalidateTag('roles', { expire: 0 });
        revalidateTag('albums', { expire: 0 });
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Delete role error:", error);
        return NextResponse.json({ error: "Failed to delete role" }, { status: 500 });
    }
}
