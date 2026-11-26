"use client";

import Link from "next/link";

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <html lang="en">
            <body className="min-h-screen bg-[#050505] text-white flex items-center justify-center p-6">
                <div className="max-w-md w-full rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center space-y-4">
                    <h2 className="text-xl font-bold tracking-tight">Something went wrong</h2>
                    <p className="text-sm text-zinc-400">
                        A temporary server error occurred while loading this page.
                    </p>
                    {error.digest && (
                        <p className="text-[11px] font-mono text-zinc-600">Digest: {error.digest}</p>
                    )}
                    <div className="flex items-center justify-center gap-3 pt-2">
                        <button
                            onClick={() => reset()}
                            className="px-5 py-2 rounded-full bg-white text-black text-xs font-bold hover:bg-zinc-200 transition"
                        >
                            Try Again
                        </button>
                        <Link
                            href="/"
                            className="px-5 py-2 rounded-full border border-white/10 text-xs font-semibold text-zinc-300 hover:text-white transition"
                        >
                            Home
                        </Link>
                    </div>
                </div>
            </body>
        </html>
    );
}
