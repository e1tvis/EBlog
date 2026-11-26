import { getSession } from "@/lib/session";
import { isOwner as checkIsOwner } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import FeedClientWrapper from "./FeedClientWrapper";

export default async function FeedPage() {
    const session = await getSession();
    if (!session?.user?.email) redirect("/api/auth/signin?callbackUrl=/feed");

    const isOwner = checkIsOwner(session);
    const dbUser = await prisma.user.findUnique({
        where: { email: session.user.email.toLowerCase() },
        select: { id: true },
    });

    return (
        <FeedClientWrapper isOwner={isOwner} currentUserId={dbUser?.id || session.user.email} />
    );
}
