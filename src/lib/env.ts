import { z } from "zod";

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
    z.preprocess((val) => (typeof val === "string" && val.trim() === "" ? undefined : val), schema);

/**
 * Validates environment variables at module load time.
 * Logs readable warnings on cold start if required secrets are missing or malformed.
 */
const envSchema = z.object({
    DATABASE_URL: emptyToUndefined(z.string().url()),
    DIRECT_URL: emptyToUndefined(z.string().url().optional()),
    NEXTAUTH_SECRET: emptyToUndefined(z.string().min(16, "NEXTAUTH_SECRET must be at least 16 chars")),

    GITHUB_ID: emptyToUndefined(z.string().min(1).optional()),
    GITHUB_SECRET: emptyToUndefined(z.string().min(1).optional()),
    GOOGLE_CLIENT_ID: emptyToUndefined(z.string().min(1).optional()),
    GOOGLE_CLIENT_SECRET: emptyToUndefined(z.string().min(1).optional()),

    OWNER_EMAIL: emptyToUndefined(z.string().optional()),
    OWNER_USERNAME: emptyToUndefined(z.string().optional()),

    R2_ENDPOINT: emptyToUndefined(z.string().url().optional()),
    R2_ACCESS_KEY_ID: emptyToUndefined(z.string().min(1).optional()),
    R2_SECRET_ACCESS_KEY: emptyToUndefined(z.string().min(1).optional()),
    R2_BUCKET_NAME: emptyToUndefined(z.string().min(1).optional()),
    R2_PUBLIC_URL: emptyToUndefined(z.string().url().optional()),

    ORACLE_ENDPOINT: emptyToUndefined(z.string().url().optional()),
    ORACLE_ACCESS_KEY_ID: emptyToUndefined(z.string().optional()),
    ORACLE_SECRET_ACCESS_KEY: emptyToUndefined(z.string().optional()),
    ORACLE_BUCKET_NAME: emptyToUndefined(z.string().optional()),
    ORACLE_REGION: emptyToUndefined(z.string().optional()),
    ORACLE_PUBLIC_URL: emptyToUndefined(z.string().url().optional()),

    STORAGE_PROVIDER: emptyToUndefined(z.enum(["r2", "oracle", "s3", "backblaze"]).optional()),
    CRON_SECRET: emptyToUndefined(z.string().optional()),
}).refine(
    (data) => Boolean(data.OWNER_EMAIL || data.OWNER_USERNAME),
    { message: "At least one of OWNER_EMAIL or OWNER_USERNAME should be configured", path: ["OWNER_EMAIL"] }
);

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Partial<Env> {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map(i => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
        console.warn(`⚠️ Environment configuration warning:\n${issues}`);
        return (process.env as unknown) as Partial<Env>;
    }
    return parsed.data;
}

// Validated once per cold start, cached on the module.
export const env = validateEnv();
