/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextAuthOptions } from 'next-auth';
import GitHubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';
import { prisma } from '@/lib/prisma';
import { isOwner, normalizeGoogleIdentifier } from '@/lib/auth-utils';

export const authOptions: NextAuthOptions = {
    providers: [
        GitHubProvider({
            clientId: process.env.GITHUB_ID || '',
            clientSecret: process.env.GITHUB_SECRET || '',
            issuer: "https://github.com/login/oauth",
        }),
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID || '',
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
        }),
    ],
    callbacks: {
        async signIn({ account, profile }) {
            if (account?.provider === 'google') {
                const p = profile as any;
                if (!p?.email || p.email_verified === false) {
                    return false;
                }
            }
            return true;
        },
        async jwt({ token, user, profile, account }) {
            // Only runs with profile/account on FIRST sign-in
            if (account && profile) {
                const provider = account.provider; // "github" | "google"
                const p = profile as any;

                if (provider === 'github') {
                    const login = String(p.login || '').toLowerCase().trim();
                    token.username = login;
                    token.name = p.name || p.login;
                    token.email = `${login}-git`;
                } else if (provider === 'google') {
                    const rawEmail = String(p.email || user?.email || '').toLowerCase().trim();
                    const identifier = normalizeGoogleIdentifier(rawEmail);
                    token.username = rawEmail.split('@')[0];
                    token.name = p.name || token.username;
                    token.email = identifier;
                }

                token.provider = provider;

                const identifier = (token.email as string)?.toLowerCase();
                const displayName = (token.name as string) || identifier;
                if (identifier) {
                    const ownerSession = {
                        user: {
                            email: identifier,
                            username: token.username as string,
                            provider,
                        },
                        expires: '',
                    } as any;
                    const ownerFlag = isOwner(ownerSession);

                    try {
                        await prisma.user.upsert({
                            where: { email: identifier },
                            update: {
                                name: displayName,
                                ...(ownerFlag ? { role: 'admin' } : {}),
                            },
                            create: {
                                email: identifier,
                                name: displayName,
                                role: ownerFlag ? 'admin' : 'viewer',
                            },
                        });
                    } catch (err) {
                        console.error('User upsert failed (non-fatal):', err);
                    }
                }
            }

            // Always keep email and username lowercase and strip legacy -google suffix
            if (typeof token.email === 'string') {
                token.email = token.email.toLowerCase().replace(/-google$/, '');
            }
            if (typeof token.username === 'string') {
                token.username = token.username.toLowerCase();
            }

            return token;
        },
        session({ session, token }) {
            if (session.user) {
                (session.user as any).id = token.sub;
                (session.user as any).username = token.username as string;
                (session.user as any).provider = token.provider as string;
                session.user.name = token.name as string || session.user.name;
                session.user.email = token.email as string || session.user.email;
            }
            return session;
        },
    },
    pages: {
        signIn: '/signin',
        error: '/signin',
    },
    secret: process.env.NEXTAUTH_SECRET,
};
