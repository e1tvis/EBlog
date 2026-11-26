# EBlog

A private, self-hosted photo and video studio built with **Next.js 16**, **React 19**, **Prisma**, and hybrid S3-compatible object storage (**Cloudflare R2** + **Oracle Cloud Object Storage**).

Designed to store and share full-resolution photos, raw travel albums, vertical/4K+ video, and private vault files with zero social-platform compression and strict role-based access control.

---

## Features

- **Uncompressed Media & Hybrid Storage** — Direct presigned browser uploads to Cloudflare R2 and proxied uploads to Oracle OCI Object Storage, with live bucket usage tracking and one-click storage sync.
- **Fast Server-Side Image Pipeline** — Client-side HEIC-to-JPEG conversion (`heic2any`), EXIF date/GPS extraction (`exifr`), perceptual DCT hashing (`pHash`) for duplicate detection, and coalesced `sharp` master thumbnail caching.
- **Grid, Timeline & Geo-Map Views** — Browse collections in a responsive masonry/grid layout, chronological EXIF timeline, or interactive clustered Leaflet map with manual coordinate pinning.
- **Immersive Lightbox** — 7.5x pan/zoom viewer, keyboard and swipe navigation, custom video frame thumbnail capture, inline captions, likes, and threaded comments with `@mentions`.
- **Granular Role-Based Access Control (RBAC)** — Invite-only albums and nested sub-albums, custom color-coded roles with optional expiration windows, per-photo role exclusions, and HMAC-signed thumbnail URLs.
- **Secure Vault (`/vault`)** — Owner-only isolated storage area for private archives, documents, and proprietary files, completely excluded from gallery indexes.
- **Feed & Direct Messaging** — Role-targeted announcement feed (`/feed`) with auto-expiring posts, real-time notifications, and built-in 1-on-1 Messenger (`/messages`) supporting text, images, and voice notes.
- **Dual Theme UI** — Glassmorphic Dark and Satin Silver themes powered by Tailwind CSS 4.

---

## Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Framework** | Next.js 16.1 (App Router, Turbopack, `src/proxy.ts`) |
| **UI** | React 19, Tailwind CSS 4, Sonner |
| **Database** | PostgreSQL (Neon Serverless) + Prisma ORM |
| **Authentication** | NextAuth.js v4 (GitHub & Google OAuth) |
| **Object Storage** | AWS SDK v3 (`@aws-sdk/client-s3`) — Cloudflare R2 & Oracle OCI |
| **Media & Maps** | `sharp`, `exifr`, `heic2any`, `leaflet`, `react-leaflet-cluster` |

---

## Getting Started

### 1. Prerequisites
- **Node.js** 20+
- **PostgreSQL** database (e.g. [Neon](https://neon.tech))
- **Cloudflare R2** bucket (and optionally an **Oracle Cloud** S3-compatible bucket)
- **GitHub** and/or **Google** OAuth credentials

### 2. Environment Variables
Copy `.env.example` to `.env` and configure the required credentials:

```bash
cp .env.example .env
```

| Variable | Description |
| :--- | :--- |
| `DATABASE_URL` | Pooled PostgreSQL connection string |
| `DIRECT_URL` | Direct PostgreSQL connection string (used by Prisma migrations) |
| `NEXTAUTH_SECRET` | Random secret string (minimum 32 characters) |
| `NEXTAUTH_URL` | Canonical deployment URL (e.g. `http://localhost:3000`) |
| `GITHUB_ID` / `GITHUB_SECRET` | GitHub OAuth app credentials |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth client credentials |
| `OWNER_USERNAME` | Owner's GitHub username (grants full admin access) |
| `OWNER_EMAIL` | Owner identifier (`<github-login>-git` or Google email) |
| `R2_ENDPOINT` / `R2_BUCKET_NAME` | Cloudflare R2 S3 API endpoint and bucket name |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare R2 API token credentials |
| `ORACLE_*` | *(Optional)* Oracle OCI Object Storage S3-compatible credentials |
| `CRON_SECRET` | *(Optional)* Bearer secret for `/api/cron/cleanup` |

### 3. Install & Run

```bash
npm install
npx prisma migrate deploy
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## Project Structure

```text
├── prisma/               # Prisma schema and SQL migrations
├── src/
│   ├── app/              # Next.js App Router pages & API routes
│   │   ├── admin/        # Role manager & archived posts
│   │   ├── api/          # REST handlers (photos, albums, sync, roles, feed, chat, cron)
│   │   ├── feed/         # Role-filtered post feed
│   │   ├── gallery/      # Collections & nested album routes
│   │   ├── messages/     # Direct messaging client
│   │   └── vault/        # Owner-only Secure Vault
│   ├── components/       # Lightbox, PhotoGrid, Map, Messenger, UploadModal, Admin UI
│   ├── lib/              # Storage abstraction, Sharp pHash/EXIF, cached DB queries, RBAC
│   ├── auth.ts           # NextAuth configuration & user provisioning
│   ├── instrumentation.ts# Cold-start environment validation
│   └── proxy.ts          # Next.js 16 auth route guard
└── next.config.ts        # Security headers, CSP, and build config
```

---

## License

All rights reserved. Personal and authorized use only.
