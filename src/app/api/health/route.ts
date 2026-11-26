import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
    const checks: Record<string, "ok" | "fail"> = {};
    let dbErrorCode: string | undefined;
    let healthy = true;

    try {
        await prisma.$queryRaw`SELECT 1`;
        checks.database = "ok";
    } catch (err: unknown) {
        checks.database = "fail";
        healthy = false;
        const e = err as { code?: string; errorCode?: string; name?: string };
        dbErrorCode = e?.code || e?.errorCode || e?.name || "UnknownError";
        console.error("[health] Database check failed:", err);
    }

    checks.r2 = (process.env.R2_ENDPOINT && process.env.R2_BUCKET_NAME) ? "ok" : "fail";
    if (checks.r2 === "fail") healthy = false;

    return NextResponse.json(
        {
            status: healthy ? "healthy" : "unhealthy",
            checks,
            ...(dbErrorCode ? { dbErrorCode } : {}),
            timestamp: new Date().toISOString(),
        },
        { status: healthy ? 200 : 503 }
    );
}
