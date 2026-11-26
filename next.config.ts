import type { NextConfig } from "next";

function extractOrigin(urlStr?: string): string | null {
  if (!urlStr) return null;
  try {
    return new URL(urlStr).origin;
  } catch {
    return null;
  }
}

const extraStorageOrigins = Array.from(
  new Set(
    [
      extractOrigin(process.env.R2_ENDPOINT),
      extractOrigin(process.env.R2_PUBLIC_URL),
      extractOrigin(process.env.ORACLE_ENDPOINT),
      extractOrigin(process.env.ORACLE_PUBLIC_URL),
      extractOrigin(process.env.AWS_CLOUDFRONT_URL),
      extractOrigin(process.env.B2_ENDPOINT),
      extractOrigin(process.env.B2_PUBLIC_URL),
    ].filter((o): o is string => Boolean(o))
  )
);

const storageSources = [
  "https://*.r2.cloudflarestorage.com",
  "https://*.oraclecloud.com",
  "https://*.amazonaws.com",
  "https://*.backblazeb2.com",
  ...extraStorageOrigins,
].join(" ");

const cspHeader = [
  "default-src 'self'",
  `img-src 'self' blob: data: ${storageSources} https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org https://avatars.githubusercontent.com https://*.googleusercontent.com`,
  `media-src 'self' blob: data: ${storageSources}`,
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://va.vercel-scripts.com",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${storageSources} https://vitals.vercel-insights.com https://va.vercel-scripts.com`,
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "exifr", "@prisma/client", "prisma"],
  outputFileTracingIncludes: {
    "/*": ["./node_modules/.prisma/client/**/*"],
  },

  images: {
    // /api/photos/thumbnail already performs server-side Sharp resizing and
    // requires the user's session cookie (not forwarded by /_next/image).
    unoptimized: true,
  },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(self)" },
          { key: "Content-Security-Policy", value: cspHeader },
        ],
      },
    ];
  },
};

export default nextConfig;
