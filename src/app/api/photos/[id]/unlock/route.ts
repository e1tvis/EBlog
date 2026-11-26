import { NextResponse } from "next/server";

/**
 * POST /api/photos/[id]/unlock
 *
 * ⚠️ DISABLED: Returning 501 until a real payment verification step is added here
 * (e.g. confirm a completed Stripe PaymentIntent/Checkout Session tied
 * to this exact photoId + userId before calling prisma.photoUnlock.create).
 */
export async function POST() {
    return NextResponse.json(
        { error: "Photo unlock is not yet available — payment verification is not implemented." },
        { status: 501 }
    );
}
