/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { getStorage } from "@/lib/storage";
import { prisma } from "@/lib/prisma";
import { isOwner } from "@/lib/auth-utils";
import sharp from "sharp";
import { createHmac, timingSafeEqual } from 'crypto';
import { rateLimit, getClientIp } from "@/lib/rate-limit";

sharp.concurrency(2);
sharp.cache({ memory: 50, files: 0, items: 100 });

const inFlight = new Map<string, Promise<Buffer>>();

async function coalesce(cacheKey: string, generator: () => Promise<Buffer>): Promise<Buffer> {
    const existing = inFlight.get(cacheKey);
    if (existing) return existing;
    const promise = generator().finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, promise);
    return promise;
}

function thumbnailKey(originalKey: string, width: number): string {
    return `thumbs/${width}/${originalKey}.jpg`;
}

function parseCachedThumbWidth(thumbKey: string): number {
    const match = thumbKey.match(/^thumbs\/(\d+)\//);
    return match ? parseInt(match[1], 10) : 600;
}

function safeCompareHex(a: string | null, b: string): boolean {
    if (!a || a.length !== b.length) return false;
    try {
        return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
    } catch {
        return false;
    }
}

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const ip = getClientIp(req);
    const { allowed, resetAt } = rateLimit(`thumbnail:${ip}`, 300, 60_000);
    if (!allowed) {
        return NextResponse.json(
            { error: "Too many requests" },
            { status: 429, headers: { "Retry-After": String(Math.ceil((resetAt - Date.now()) / 1000)) } }
        );
    }

    const { searchParams } = new URL(req.url);
    const key = searchParams.get("key");
    const id = searchParams.get("id");
    const requestedBlur = searchParams.get("blur") === "true";
    const sig = searchParams.get("sig");
    const BREAKPOINTS = [200, 400, 600, 800, 1200];
    const parsedW = parseInt(searchParams.get("w") || "400", 10);
    const requestedWidth = Number.isNaN(parsedW) || parsedW <= 0 ? 400 : parsedW;
    const width = BREAKPOINTS.find(bp => bp >= requestedWidth) ?? BREAKPOINTS[BREAKPOINTS.length - 1];

    if (!key && !id) {
        return NextResponse.json({ error: "Missing key or id" }, { status: 400 });
    }

    const owner = isOwner(session);

    // Verify HMAC signature whenever id is provided by a non-owner
    if (id && !owner) {
        const secret = process.env.NEXTAUTH_SECRET;
        if (!secret) {
            return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
        }
        const expectedSig = createHmac('sha256', secret)
            .update(`${id}_${requestedBlur}`)
            .digest('hex');

        if (!safeCompareHex(sig, expectedSig)) {
            return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
        }
    }

    try {
        const photo = await prisma.photo.findFirst({
            where: id ? { id } : { r2Key: key! },
            select: {
                id: true,
                r2Key: true,
                r2Thumbnail: true,
                storageProvider: true,
                mediaType: true,
                filename: true,
                visibility: true,
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

        if (!photo) {
            if (!owner || id) {
                return NextResponse.json({ error: "Photo not found" }, { status: 404 });
            }
        }

        let blur = requestedBlur;

        // Enforce album/photo access, PhotoExclusion, & PAYG blur rules for non-owners
        if (!owner && photo) {
            const isRootVault = photo.album.parentId === null && photo.album.slug === "vault";
            if (photo.visibility === "hidden" || isRootVault || photo.album.visibility === "archived") {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }

            const userEmail = session.user?.email?.toLowerCase();
            const now = new Date();
            const excludedRoleIds = new Set(photo.exclusions.map(e => e.roleId));
            const isPublic = photo.album.visibility === "public";
            const hasDirectPerm = Boolean(userEmail) && photo.album.permissions.some(p => p.user?.email?.toLowerCase() === userEmail);

            // Filter album roles down to those active for this user AND not excluded on this photo
            const activeUnexcludedRoles = userEmail
                ? photo.album.roleAccess.filter(ra => {
                    if (excludedRoleIds.has(ra.roleId)) return false;
                    if (ra.role.name === "viewer") return true;
                    return ra.role.assignments.some(a =>
                        a.user?.email?.toLowerCase() === userEmail && (!a.expiresAt || a.expiresAt > now)
                    );
                })
                : [];

            const hasFullRole = activeUnexcludedRoles.some(ra => !ra.role.isPayAsYouGo);
            const hasPaygRole = activeUnexcludedRoles.some(ra => ra.role.isPayAsYouGo);

            if (!isPublic && !hasDirectPerm && !hasFullRole && !hasPaygRole) {
                return NextResponse.json({ error: "Forbidden" }, { status: 403 });
            }

            // If user only has access via a PAYG role, prevent ?key= from bypassing the blur paywall
            if (!isPublic && !hasDirectPerm && !hasFullRole && hasPaygRole) {
                const isUnlocked = Boolean(userEmail) && photo.unlocks.some(u => u.user?.email?.toLowerCase() === userEmail);
                if (!isUnlocked && !id) {
                    blur = true;
                }
            }
        }

        const actualKey = photo?.r2Key || key!;
        const provider = (photo?.storageProvider as "r2" | "oracle") ?? "r2";
        const isVideo = photo?.mediaType === "video";
        const isFile = photo?.mediaType === "file";

        const serveBuffer = async (bufferData: Uint8Array | Buffer) => {
            const buf = Buffer.from(bufferData);
            if (blur) {
                const blurred = await sharp(buf)
                    .resize(20, null, { withoutEnlargement: true })
                    .blur(5)
                    .jpeg({ quality: 20 })
                    .toBuffer();
                return new NextResponse(blurred as any, {
                    headers: {
                        "Content-Type": "image/jpeg",
                        "Cache-Control": "private, max-age=3600",
                        "Vary": "Cookie",
                    },
                });
            }
            return new NextResponse(buf as any, {
                headers: {
                    "Content-Type": "image/jpeg",
                    "Cache-Control": "private, max-age=2592000",
                    "Vary": "Cookie",
                },
            });
        };

        if (isFile) {
            const ext = photo?.filename?.split('.').pop()?.toLowerCase() || 'file';
            const placeholder = await generateFilePlaceholder(width, ext, photo?.filename || 'File');
            return serveBuffer(new Uint8Array(placeholder));
        }

        // ── Serve cached thumbnail if available and sufficient resolution ──
        if (photo?.r2Thumbnail) {
            const cachedWidth = parseCachedThumbWidth(photo.r2Thumbnail);
            if (isVideo || cachedWidth >= width) {
                try {
                    const cachedUrl = await getStorage(provider).getDownloadUrl(photo.r2Thumbnail);
                    const cachedResp = await fetch(cachedUrl);
                    if (!cachedResp.ok) throw new Error("Cached thumbnail fetch failed");
                    let bytes: Buffer = Buffer.from(await cachedResp.arrayBuffer());
                    if (!blur && !isVideo && cachedWidth > width) {
                        bytes = await sharp(bytes)
                            .resize({ width, withoutEnlargement: true })
                            .jpeg({ quality: 90, progressive: true, mozjpeg: true })
                            .toBuffer();
                    }
                    return serveBuffer(bytes);
                } catch (cachedErr: any) {
                    console.warn(`Cached thumbnail missing for ${actualKey}, regenerating. Error: ${cachedErr.message}`);
                    photo.r2Thumbnail = null;
                    prisma.photo.update({
                        where: { id: photo.id },
                        data: { r2Thumbnail: null },
                    }).catch(e => console.error("Failed to clear stale r2Thumbnail:", e.message));
                }
            }
        }

        // ── Video without cached thumbnail: return placeholder ───────
        if (isVideo) {
            const placeholder = await generateVideoPlaceholder(width);
            return serveBuffer(new Uint8Array(placeholder));
        }

        // Cache a canonical master thumbnail at max(width, 800) so smaller breakpoints
        // can reuse it without re-fetching multi-MB raw originals or leaking multiple files.
        const masterWidth = Math.max(width, 800);
        const previousThumb = photo?.r2Thumbnail || null;
        const photoId = photo?.id;

        const masterBuffer = await coalesce(`${provider}:${actualKey}:${masterWidth}`, async () => {
            const buf = await generateThumbnailFromStorage(provider, actualKey, masterWidth);
            if (photoId) {
                cacheMasterThumbnail(provider, photoId, actualKey, masterWidth, buf, previousThumb).catch(err =>
                    console.error("Thumbnail caching failed:", err.message)
                );
            }
            return buf;
        });

        if (!blur && masterWidth > width) {
            const downsized = await sharp(masterBuffer)
                .resize({ width, withoutEnlargement: true })
                .jpeg({ quality: 90, progressive: true, mozjpeg: true })
                .toBuffer();
            return serveBuffer(downsized);
        }

        return serveBuffer(masterBuffer);
    } catch (error: any) {
        console.error("Thumbnail error for key/id:", key || id, "Error:", error.message);
        const fallback = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        return new NextResponse(new Uint8Array(fallback), {
            headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" },
        });
    }
}

async function generateThumbnailFromStorage(provider: "r2" | "oracle", key: string, width: number): Promise<Buffer> {
    const downloadUrl = await getStorage(provider).getDownloadUrl(key);
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`Empty body from ${provider}: ${response.status}`);

    const byteArray = await response.arrayBuffer();
    return sharp(Buffer.from(byteArray), {
        limitInputPixels: false,
        sequentialRead: true,
        failOn: 'none',
    })
        .rotate()
        .resize({ width: Math.min(width, 1200), withoutEnlargement: true })
        .jpeg({ quality: 92, progressive: true, mozjpeg: true })
        .toBuffer();
}

async function cacheMasterThumbnail(
    provider: "r2" | "oracle",
    photoId: string,
    originalKey: string,
    width: number,
    buffer: Buffer,
    previousThumb: string | null
): Promise<void> {
    const thumbKey = thumbnailKey(originalKey, width);
    const storage = getStorage(provider);
    await storage.putObject(thumbKey, new Uint8Array(buffer), "image/jpeg");
    await prisma.photo.update({
        where: { id: photoId },
        data: { r2Thumbnail: thumbKey },
    });
    if (previousThumb && previousThumb !== thumbKey) {
        storage.deleteObject(previousThumb).catch(() => {});
    }
}

async function generateVideoPlaceholder(width: number): Promise<Buffer> {
    const w = Math.min(width, 600);
    const h = Math.round(w * 9 / 16);
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.12;
    const triSize = r * 0.7;

    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#1a1a2e"/>
                <stop offset="100%" stop-color="#0a0a0a"/>
            </linearGradient>
        </defs>
        <rect width="${w}" height="${h}" fill="url(#bg)"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.25)" stroke-width="2"/>
        <polygon points="${cx - triSize * 0.4},${cy - triSize} ${cx - triSize * 0.4},${cy + triSize} ${cx + triSize * 0.8},${cy}" fill="rgba(255,255,255,0.5)"/>
    </svg>`;

    return sharp(Buffer.from(svg))
        .jpeg({ quality: 80 })
        .toBuffer();
}

async function generateFilePlaceholder(width: number, ext: string, filename: string): Promise<Buffer> {
    const w = Math.min(width, 400);
    const h = w;

    let startColor = "#6366f1";
    let endColor = "#4338ca";

    const archives = ['zip', 'rar', 'tar', 'gz', '7z'];
    const documents = ['doc', 'docx', 'odt', 'pdf'];
    const sheets = ['xls', 'xlsx', 'ods', 'csv'];
    const text = ['txt', 'md', 'rtf', 'log'];

    if (archives.includes(ext)) {
        startColor = "#f59e0b";
        endColor = "#d97706";
    } else if (ext === 'pdf') {
        startColor = "#ef4444";
        endColor = "#dc2626";
    } else if (documents.includes(ext)) {
        startColor = "#3b82f6";
        endColor = "#2563eb";
    } else if (sheets.includes(ext)) {
        startColor = "#10b981";
        endColor = "#059669";
    } else if (text.includes(ext)) {
        startColor = "#9ca3af";
        endColor = "#4b5563";
    }

    const extUpper = ext.toUpperCase().substring(0, 4);
    const escapedFilename = filename
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    const svg = `<svg width="${w}" height="${h}" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#141419"/>
                <stop offset="100%" stop-color="#08080a"/>
            </linearGradient>
            <linearGradient id="iconGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="${startColor}"/>
                <stop offset="100%" stop-color="${endColor}"/>
            </linearGradient>
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="15" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
        </defs>

        <rect width="400" height="400" fill="url(#bgGrad)" rx="24"/>
        <rect width="398" height="398" x="1" y="1" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="2" rx="23"/>

        <circle cx="200" cy="180" r="60" fill="url(#iconGrad)" opacity="0.15" filter="url(#glow)"/>

        <g transform="translate(130, 100)">
            <path d="M 0 0 L 100 0 L 140 40 L 140 180 L 0 180 Z" fill="url(#iconGrad)" opacity="0.9" rx="12"/>
            <path d="M 100 0 L 100 40 L 140 40 Z" fill="#ffffff" opacity="0.25"/>
            <path d="M 100 0 L 100 40 L 140 40 Z" fill="rgba(0,0,0,0.15)"/>

            <line x1="25" y1="70" x2="115" y2="70" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="0.4"/>
            <line x1="25" y1="95" x2="115" y2="95" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="0.4"/>
            <line x1="25" y1="120" x2="80" y2="120" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="0.4"/>

            <rect x="25" y="140" width="90" height="28" rx="6" fill="#000000" opacity="0.4"/>
            <text x="70" y="158" font-family="monospace, ui-monospace, Courier" font-size="12" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="1">
                ${extUpper}
            </text>
        </g>

        <text x="200" y="325" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="700" fill="#f4f4f5" text-anchor="middle" opacity="0.9">
            ${escapedFilename.length > 25 ? escapedFilename.substring(0, 22) + '...' : escapedFilename}
        </text>
        <text x="200" y="350" font-family="monospace, ui-monospace, Courier" font-size="11" font-weight="500" fill="#71717a" text-anchor="middle" letter-spacing="0.5">
            SECURE VAULT STORAGE
        </text>
    </svg>`;

    return sharp(Buffer.from(svg))
        .jpeg({ quality: 88 })
        .toBuffer();
}
