import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { getStorage } from "@/lib/storage";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

// Vercel Functions enforce a 4.5 MB request body limit across all plans
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 4 MB

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const ip = getClientIp(req);
    const { allowed, resetAt } = rateLimit(`msg-upload:${ip}`, 30, 60_000);
    if (!allowed) {
        return NextResponse.json(
            { error: "Too many uploads" },
            { status: 429, headers: { "Retry-After": String(Math.ceil((resetAt - Date.now()) / 1000)) } }
        );
    }

    try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;

        if (!file) {
            return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
        }

        if (file.size > MAX_UPLOAD_BYTES) {
            return NextResponse.json({ error: "File exceeds 4MB limit" }, { status: 413 });
        }

        const mime = (file.type || "").toLowerCase();
        const isVoice = mime.startsWith("audio/") || mime.includes("webm") || mime.includes("ogg");
        const isImage = mime.startsWith("image/");

        if (!isVoice && !isImage) {
            return NextResponse.json({ error: "Only image and audio files are allowed" }, { status: 400 });
        }

        const nameParts = file.name.split('.');
        const rawExt = nameParts.length > 1 ? nameParts.pop() : (isVoice ? "webm" : "jpg");
        const ext = (rawExt || "bin").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
        const prefix = isVoice ? 'messages/voice' : 'messages/images';
        const safeUser = session.user.email.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_');
        const key = `${prefix}/${Date.now()}-${safeUser}.${ext}`;

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        await getStorage("r2").putObject(key, buffer, file.type || "application/octet-stream");

        return NextResponse.json({ key });
    } catch (error) {
        console.error("Upload message media error:", error);
        return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
}
