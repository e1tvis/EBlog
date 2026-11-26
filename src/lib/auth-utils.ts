import type { Session } from 'next-auth';

/**
 * Normalize a Google email to match how `src/auth.ts` stores consumer Gmail
 * identifiers while preserving custom domains and preventing `-git` collisions.
 */
export function normalizeGoogleIdentifier(rawEmail: string): string {
    const email = rawEmail.toLowerCase().trim();
    const atIdx = email.indexOf('@');
    if (atIdx === -1) return email;
    const localPart = email.slice(0, atIdx);
    const domain = email.slice(atIdx + 1);
    if ((domain === 'gmail.com' || domain === 'googlemail.com') && !localPart.endsWith('-git')) {
        return localPart;
    }
    return email;
}

/**
 * Check if the current session belongs to the site owner.
 *
 * Strictly isolates GitHub vs Google identities to prevent cross-provider
 * or arbitrary-domain spoofing:
 *   - GitHub users ("username-git" / provider="github") match against OWNER_USERNAME
 *     or OWNER_EMAIL ending with "-git".
 *   - Google users match against OWNER_EMAIL (exact match, or verified Gmail prefix
 *     when OWNER_EMAIL is a @gmail.com/@googlemail.com address).
 */
export function isOwner(session: Session | null): boolean {
    if (!session?.user) return false;
    const ownerEmail = process.env.OWNER_EMAIL?.toLowerCase().trim();
    const ownerUsername = process.env.OWNER_USERNAME?.toLowerCase().trim();

    const userEmail = session.user.email?.toLowerCase().trim();
    const userUsername = (session.user as { username?: string })?.username?.toLowerCase().trim();
    const provider = (session.user as { provider?: string })?.provider?.toLowerCase();

    const isGithubUser = provider === 'github' || Boolean(userEmail?.endsWith('-git'));

    if (isGithubUser) {
        const ghLogin = userUsername || userEmail?.replace(/-git$/, '');
        if (!ghLogin) return false;
        if (ownerEmail && ownerEmail === `${ghLogin}-git`) return true;
        if (ownerUsername && ownerUsername === ghLogin && (!ownerEmail || ownerEmail.endsWith('-git'))) {
            return true;
        }
        return false;
    }

    // Google / email-based provider: match strictly against OWNER_EMAIL (never OWNER_USERNAME)
    if (!userEmail || !ownerEmail || ownerEmail.endsWith('-git')) return false;
    if (userEmail === ownerEmail) return true;

    const normalizedOwner = normalizeGoogleIdentifier(ownerEmail);
    return !userEmail.includes('@') && userEmail === normalizedOwner;
}

/**
 * Returns all valid DB `User.email` identifiers that could belong to the site owner
 * for admin notification fan-out.
 */
export function getOwnerEmailCandidates(): string[] {
    const ownerEmail = process.env.OWNER_EMAIL?.toLowerCase().trim();
    const ownerUsername = process.env.OWNER_USERNAME?.toLowerCase().trim();
    const candidates = new Set<string>();

    if (ownerEmail) {
        candidates.add(ownerEmail);
        if (!ownerEmail.endsWith('-git')) {
            candidates.add(normalizeGoogleIdentifier(ownerEmail));
        }
    }
    if (ownerUsername) {
        candidates.add(`${ownerUsername}-git`);
    }
    return Array.from(candidates);
}
