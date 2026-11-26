import { PrismaClient } from '@prisma/client';

function buildDatasourceUrl(): string | undefined {
    const raw = process.env.DATABASE_URL || process.env.DIRECT_URL;
    if (!raw) return undefined;
    try {
        const parsed = new URL(raw);
        // Neon / PgBouncer transaction poolers require pgbouncer=true in Prisma 5
        // so named prepared statements don't collide across pooled connections (42P05).
        if (parsed.hostname.includes('-pooler.') && !parsed.searchParams.has('pgbouncer')) {
            parsed.searchParams.set('pgbouncer', 'true');
        }
        if (!parsed.searchParams.has('connect_timeout')) {
            parsed.searchParams.set('connect_timeout', '15');
        }
        return parsed.toString();
    } catch {
        return raw;
    }
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const datasourceUrl = buildDatasourceUrl();

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        log: ['error'],
        ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
    });

// Reuse warm instance across serverless invocations
globalForPrisma.prisma = prisma;
