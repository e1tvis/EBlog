import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revalidateTag } from "next/cache";
import { isOwner, normalizeGoogleIdentifier } from "@/lib/auth-utils";

// POST assign a user to a role by email
export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { roleId, userEmail } = await req.json();
        if (!roleId || !userEmail) {
            return NextResponse.json({ error: "roleId and userEmail required" }, { status: 400 });
        }

        const rawEmail = String(userEmail).trim().toLowerCase();
        const normalizedEmail = rawEmail.endsWith('-git')
            ? rawEmail
            : normalizeGoogleIdentifier(rawEmail);

        // Find or create user
        const user = await prisma.user.upsert({
            where: { email: normalizedEmail },
            update: {},
            create: { email: normalizedEmail, name: rawEmail.split('@')[0] },
        });

        // Fetch role to get durationDays
        const role = await prisma.role.findUnique({ where: { id: roleId } });
        if (!role) {
            return NextResponse.json({ error: "Role not found" }, { status: 404 });
        }

        let expiresAt: Date | null = null;
        if (role.durationDays) {
            expiresAt = new Date(Date.now() + role.durationDays * 24 * 60 * 60 * 1000);
        }

        const assignment = await prisma.roleAssignment.upsert({
            where: { roleId_userId: { roleId, userId: user.id } },
            update: { expiresAt },
            create: { roleId, userId: user.id, expiresAt },
        });

        revalidateTag('roles', { expire: 0 });
        revalidateTag('albums', { expire: 0 });
        return NextResponse.json(assignment);
    } catch (error) {
        console.error("Assign role error:", error);
        return NextResponse.json({ error: "Failed to assign role" }, { status: 500 });
    }
}

// DELETE remove a user from a role
export async function DELETE(req: Request) {
    const session = await getServerSession(authOptions);
    if (!isOwner(session)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { id } = await req.json();
        if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

        await prisma.roleAssignment.deleteMany({ where: { id } });

        revalidateTag('roles', { expire: 0 });
        revalidateTag('albums', { expire: 0 });
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Remove role assignment error:", error);
        return NextResponse.json({ error: "Failed to remove role assignment" }, { status: 500 });
    }
}
