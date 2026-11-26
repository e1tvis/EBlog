-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastSeen" TIMESTAMP(3);

-- Deduplicate any historical duplicate Photo.r2Key rows before creating unique index
WITH ranked AS (
    SELECT
        p."id",
        p."r2Key",
        FIRST_VALUE(p."id") OVER (
            PARTITION BY p."r2Key"
            ORDER BY
                (CASE WHEN EXISTS (SELECT 1 FROM "Album" a WHERE a."coverPhotoId" = p."id") THEN 0 ELSE 1 END),
                (CASE WHEN p."visibility" != 'hidden' THEN 0 ELSE 1 END),
                p."uploadedAt" ASC,
                p."id" ASC
        ) AS "keepId",
        ROW_NUMBER() OVER (
            PARTITION BY p."r2Key"
            ORDER BY
                (CASE WHEN EXISTS (SELECT 1 FROM "Album" a WHERE a."coverPhotoId" = p."id") THEN 0 ELSE 1 END),
                (CASE WHEN p."visibility" != 'hidden' THEN 0 ELSE 1 END),
                p."uploadedAt" ASC,
                p."id" ASC
        ) AS "rn"
    FROM "Photo" p
),
repoint_covers AS (
    UPDATE "Album" a
    SET "coverPhotoId" = r."keepId"
    FROM ranked r
    WHERE r."rn" > 1 AND a."coverPhotoId" = r."id"
)
DELETE FROM "Photo"
WHERE "id" IN (SELECT "id" FROM ranked WHERE "rn" > 1);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Photo_r2Key_key" ON "Photo"("r2Key");
