import exifr from 'exifr';
import { generatePHash, hammingDistance } from './phash';
import { prisma } from './prisma';

export interface ImageMetadataResult {
    lat: number | null;
    lng: number | null;
    takenAt: Date | null;
    takenAtRaw: string | null;
    phash: string | null;
    isDuplicate: boolean;
    duplicateOf?: string;
}

function parseExifDate(rawValue: unknown): { date: Date; raw: string } | null {
    if (!rawValue) return null;
    if (rawValue instanceof Date) {
        if (!isNaN(rawValue.getTime())) {
            return { date: rawValue, raw: rawValue.toISOString() };
        }
        return null;
    }
    const rawStr = String(rawValue).trim();
    // Convert EXIF "YYYY:MM:DD HH:MM:SS" format to ISO-like "YYYY-MM-DDTHH:MM:SS"
    const normalized = rawStr.replace(/^(\d{4}):(\d{2}):(\d{2})\s+/, '$1-$2-$3T');
    const parsed = new Date(normalized);
    if (!isNaN(parsed.getTime())) {
        return { date: parsed, raw: rawStr };
    }
    return null;
}

export async function processImageMetadata(buffer: Buffer | Uint8Array, albumId: string): Promise<ImageMetadataResult> {
    let lat: number | null = null;
    let lng: number | null = null;
    let takenAt: Date | null = null;
    let takenAtRaw: string | null = null;
    let phash: string | null = null;
    let isDuplicate = false;
    let duplicateOf: string | undefined;

    // 1. Parse EXIF
    try {
        const exifObj = await exifr.parse(buffer, {
            gps: true,
            tiff: true,
            exif: true,
            mergeOutput: true,
        });

        if (exifObj) {
            if (Number.isFinite(exifObj.latitude) && Number.isFinite(exifObj.longitude)) {
                lat = exifObj.latitude;
                lng = exifObj.longitude;
            }
            const dateResult = parseExifDate(exifObj.DateTimeOriginal ?? exifObj.CreateDate);
            if (dateResult) {
                takenAt = dateResult.date;
                takenAtRaw = dateResult.raw;
            }
        }
    } catch (err) {
        console.error("[photo-processor] Exif parsing error:", err);
    }

    // 2. Generate pHash & detect duplicates
    try {
        phash = await generatePHash(buffer);

        const existingPhotosInAlbum = await prisma.photo.findMany({
            where: { albumId, phash: { not: null } },
            select: { id: true, phash: true, filename: true }
        });

        for (const existing of existingPhotosInAlbum) {
            if (existing.phash) {
                const dist = hammingDistance(phash, existing.phash);
                if (dist <= 10) {
                    isDuplicate = true;
                    duplicateOf = existing.id;
                    break;
                }
            }
        }
    } catch (err) {
        console.error("[photo-processor] pHash error:", err);
    }

    return { lat, lng, takenAt, takenAtRaw, phash, isDuplicate, duplicateOf };
}
