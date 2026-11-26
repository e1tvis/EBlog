import { getSession } from "@/lib/session";
import Link from "next/link";

export default async function Page() {
  const session = await getSession();

  return (
    <div className="min-h-[calc(100vh-73px)] p-6 md:p-12 flex flex-col items-center justify-center animate-in">
      <div className="max-w-5xl w-full grid md:grid-cols-12 gap-10 md:gap-12 items-center">
        {/* Hero Copy */}
        <div className="md:col-span-7 space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 glass-card text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Private Media Archive
          </div>

          <h1 className="text-5xl sm:text-6xl md:text-7xl font-bold tracking-tighter leading-[0.95] premium-gradient-text">
            Frames Worth <br /> Keeping.
          </h1>

          <p className="text-zinc-400 text-base md:text-lg max-w-md leading-relaxed">
            An invite-only archive for original-resolution photography, travel logs, and raw footage — preserved without platform compression.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            {session?.user ? (
              <>
                <Link
                  href="/gallery"
                  className="px-7 py-3 bg-white text-black rounded-full text-sm font-bold hover:scale-105 active:scale-95 transition duration-300 shadow-[0_0_20px_rgba(255,255,255,0.2)]"
                >
                  Open Gallery
                </Link>
                <Link
                  href="/feed"
                  className="px-6 py-3 glass-card rounded-full text-sm font-semibold text-zinc-300 hover:text-white border border-white/10 transition duration-300"
                >
                  View Feed
                </Link>
              </>
            ) : (
              <Link
                href="/signin"
                className="px-7 py-3 bg-white text-black rounded-full text-sm font-bold hover:scale-105 active:scale-95 transition duration-300 shadow-[0_0_20px_rgba(255,255,255,0.2)]"
              >
                Sign In
              </Link>
            )}
            <a
              href="https://github.com/e1tvis"
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-3 glass-card rounded-full text-sm font-semibold text-zinc-300 hover:text-white border border-white/10 transition duration-300"
            >
              GitHub
            </a>
          </div>
        </div>

        {/* Author / Bio Card */}
        <div className="md:col-span-5">
          <div className="relative glass-card rounded-3xl p-8 md:p-9 overflow-hidden border border-white/10 group">
            <div className="absolute -bottom-24 -left-24 w-64 h-64 bg-white/5 blur-[100px] rounded-full pointer-events-none" />
            <div className="absolute -top-24 -right-24 w-64 h-64 bg-white/5 blur-[100px] rounded-full pointer-events-none" />

            <div className="relative z-10 flex flex-col justify-between space-y-6">
              <div className="flex items-center justify-between">
                <div className="w-12 h-12 rounded-2xl bg-white flex items-center justify-center text-black text-xl font-black shadow-lg group-hover:scale-105 transition duration-300">
                  E
                </div>
                <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                  Vilnius, LT
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex items-baseline gap-2.5">
                  <h2 className="text-2xl font-bold tracking-tight premium-gradient-text">
                    Eitvydas
                  </h2>
                  <span className="text-xs font-mono text-zinc-500">@e1tvis</span>
                </div>
                <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Software Engineering · Vilnius University
                </p>
                <p className="text-sm text-zinc-400 leading-relaxed pt-2">
                  Building clean web systems and maintaining a self-hosted home for personal photography, video, and travel archives.
                </p>
              </div>

              <div className="pt-4 border-t border-white/10 flex flex-wrap gap-2">
                {["Full-Res Originals", "EXIF & Geo-Map", "Hybrid S3 Cloud", "Role-Gated"].map((tag) => (
                  <span
                    key={tag}
                    className="px-2.5 py-1 rounded-md bg-white/5 border border-white/5 text-[10px] font-mono text-zinc-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
