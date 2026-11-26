/* eslint-disable @typescript-eslint/no-explicit-any */
import { getSession } from "@/lib/session";
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { createHmac } from 'crypto';
import { prisma } from '@/lib/prisma';
import { getCachedAlbumByPath, getCachedAllPhotosRecursive } from '@/lib/db';
import { isOwner as checkIsOwner } from '@/lib/auth-utils';

const UploadModal = dynamic(() => import('@/components/UploadModal'));
const PhotoGrid = dynamic(() => import('@/components/PhotoGrid'));
const CreateAlbumButton = dynamic(() => import('@/components/CreateAlbumButton'));
const AlbumActionsMenu = dynamic(() => import('@/components/AlbumActionsMenu'));

interface PageProps {
    params: Promise<{ slug: string[] }>;
    searchParams: Promise<{ showArchived?: string }>;
}

export default async function AlbumPage({ params, searchParams }: PageProps) {
    const { slug } = await params;
    if (slug && slug[0] === 'vault') {
        notFound();
    }
    const { showArchived } = await searchParams;
    const isArchivedView = showArchived === 'true';
    const session = await getSession();
    const isOwner = checkIsOwner(session);
    const userEmail = session?.user?.email?.toLowerCase() || null;

    // Cached: album tree resolution + photos + children covers (60s TTL)
    const currentAlbum = await getCachedAlbumByPath(slug, isOwner, isArchivedView, userEmail);
    if (!currentAlbum) notFound();

    const hasDirectPermission =
        isOwner ||
        currentAlbum.visibility === 'public' ||
        (Boolean(userEmail) && currentAlbum.permissions.some((p: any) => p.user?.email?.toLowerCase() === userEmail));

    // Fetch active album roles for non-owners to evaluate role access, PAYG, and PhotoExclusion
    let accessibleRoles: { roleId: string; role: { id: string; name: string; isPayAsYouGo: boolean; blurPreviewCount: number | null; photoUnlockPrice: number | null } }[] = [];
    let hasPermission = hasDirectPermission;

    if (userEmail && !isOwner) {
        accessibleRoles = await prisma.roleAlbumAccess.findMany({
            where: {
                albumId: currentAlbum.id,
                role: {
                    OR: [
                        {
                            assignments: {
                                some: {
                                    user: { email: userEmail },
                                    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                                },
                            },
                        },
                        { name: 'viewer' },
                    ],
                },
            },
            include: { role: true },
        });

        if (!hasPermission && accessibleRoles.length > 0) {
            hasPermission = true;
        }
    }
    if (!hasPermission) redirect('/gallery');

    const hasAnyPaygRole = !hasDirectPermission && accessibleRoles.some(ra => ra.role.isPayAsYouGo);

    // Get current user's DB id for like & unlock checks
    let currentUserId: string | null = null;
    if (userEmail) {
        const dbUser = await prisma.user.findUnique({ where: { email: userEmail }, select: { id: true } });
        currentUserId = dbUser?.id ?? null;
    }

    const userUnlocks = new Set<string>();
    if (hasAnyPaygRole && currentUserId) {
        const unlocks = await prisma.photoUnlock.findMany({
            where: { userId: currentUserId, photoId: { in: currentAlbum.photos.map((p: any) => p.id) } },
            select: { photoId: true }
        });
        unlocks.forEach((u: { photoId: string }) => userUnlocks.add(u.photoId));
    }

    let lockedCount = 0;
    const secret = process.env.NEXTAUTH_SECRET || "";

    // Build photo data — NO per-photo signed URL generation during SSR.
    const photosForGrid = currentAlbum.photos.map((photo: any) => {
        try {
            let isPayAsYouGoForPhoto = false;
            let paygPreviewCount = 3;
            let fallbackPaygPrice = 0;

            if (!hasDirectPermission) {
                const excludedIds = new Set<string>((photo.exclusions || []).map((ex: { roleId: string }) => ex.roleId));
                const rolesForPhoto = accessibleRoles.filter(ra => !excludedIds.has(ra.roleId));

                // Photo is excluded across all of the user's album-granting roles
                if (rolesForPhoto.length === 0) return null;

                const hasFullAccessRole = rolesForPhoto.some(ra => !ra.role.isPayAsYouGo);
                if (!hasFullAccessRole) {
                    isPayAsYouGoForPhoto = true;
                    paygPreviewCount = rolesForPhoto[0].role.blurPreviewCount || 3;
                    fallbackPaygPrice = rolesForPhoto[0].role.photoUnlockPrice ?? 0;
                }
            }

            const likeCount = photo.likes?.length ?? 0;
            const liked = currentUserId ? photo.likes?.some((l: any) => l.userId === currentUserId) : false;

            let isBlurred = false;
            let displayUnlockPrice = photo.unlockPrice ?? null;
            let redactedR2Key = photo.r2Key;

            if (isPayAsYouGoForPhoto && !userUnlocks.has(photo.id)) {
                if (lockedCount >= paygPreviewCount) return null;
                lockedCount++;
                isBlurred = true;
                redactedR2Key = "REDACTED";

                if (displayUnlockPrice === null) {
                    const paygRolePrice = currentAlbum.roleAccess?.find((r: any) => r.role?.isPayAsYouGo)?.role?.photoUnlockPrice;
                    displayUnlockPrice = paygRolePrice ?? fallbackPaygPrice;
                }
            }

            const sig = secret
                ? createHmac('sha256', secret).update(`${photo.id}_${isBlurred}`).digest('hex')
                : '';
            const thumbnailUrl = `/api/photos/thumbnail?id=${photo.id}&w=400&v=2&blur=${isBlurred}&sig=${sig}`;

            return {
                id: photo.id,
                albumId: currentAlbum.id,
                filename: isBlurred ? 'Locked Content' : photo.filename,
                fileSize: isBlurred ? 0 : photo.fileSize,
                uploadedAt: photo.uploadedAt || '',
                takenAt: isBlurred ? null : (photo.takenAt ?? null),
                lat: isBlurred ? null : (photo.lat ?? null),
                lng: isBlurred ? null : (photo.lng ?? null),
                thumbnailUrl,
                fullUrl: undefined,
                r2Key: redactedR2Key,
                storageProvider: photo.storageProvider || 'r2',
                mediaType: photo.mediaType || 'image',
                duration: isBlurred ? null : (photo.duration ?? null),
                width: isBlurred ? undefined : photo.width,
                height: isBlurred ? undefined : photo.height,
                caption: isBlurred ? null : (photo.caption ?? null),
                sortOrder: photo.sortOrder ?? null,
                liked: isBlurred ? false : liked,
                likeCount: isBlurred ? 0 : likeCount,
                isBlurred,
                unlockPrice: displayUnlockPrice,
            };
        } catch { return null; }
    });
    const validPhotos = photosForGrid.filter(Boolean);

    // Get ALL photos (including from sub-albums) for cover picker — cached
    let allPhotosForCover: { id: string; filename: string; thumbnailUrl: string }[] = [];
    if (isOwner) {
        const allRaw = await getCachedAllPhotosRecursive(currentAlbum.id);
        allPhotosForCover = allRaw.map(p => ({
            id: p.id,
            filename: p.filename,
            thumbnailUrl: `/api/photos/thumbnail?key=${encodeURIComponent(p.r2Key)}&w=400&v=2`,
        }));
    }

    const childAlbumsWithCovers = currentAlbum.children;

    const hasChildren = currentAlbum.children.length > 0;
    const hasPhotos = validPhotos.length > 0;
    const hasVideos = validPhotos.some((p: any) => p?.mediaType === 'video');
    const breadcrumb = slug.slice(0, -1);

    return (
        <div className="p-8 md:p-12 max-w-7xl mx-auto">
            {/* Top Navigation Bar */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-12">
                <div className="flex flex-col gap-4">
                    <Link
                        href={breadcrumb.length > 0 ? `/gallery/${breadcrumb.join('/')}` : '/gallery'}
                        className="group flex items-center gap-2 text-zinc-500 hover:text-white transition"
                    >
                        <div className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center group-hover:bg-white group-hover:text-black transition duration-300">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="m15 18-6-6 6-6" /></svg>
                        </div>
                        <span className="text-sm font-medium">Back</span>
                    </Link>

                    <div className="flex flex-col">
                        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 mb-1">
                            <Link href="/gallery" className="hover:text-zinc-300 transition">Gallery</Link>
                            {breadcrumb.map((part, i) => (
                                <span key={i} className="flex items-center gap-2">
                                    <span>/</span>
                                    <Link href={`/gallery/${slug.slice(0, i + 1).join('/')}`} className="hover:text-zinc-300 transition">{part}</Link>
                                </span>
                            ))}
                        </div>
                        <h1 className="text-4xl md:text-5xl font-bold tracking-tight premium-gradient-text">
                            {currentAlbum.name}
                        </h1>
                    </div>
                </div>

                {isOwner && (
                    <div className="flex items-center gap-3 shrink-0">
                        <CreateAlbumButton parentId={currentAlbum.id} label="Sub-Album" />
                        <UploadModal albumId={currentAlbum.id} />
                        <AlbumActionsMenu
                            albumId={currentAlbum.id}
                            albumName={currentAlbum.name}
                            isArchived={currentAlbum.visibility === 'archived'}
                            isArchivedView={isArchivedView}
                            currentUrl={`/gallery/${slug.join('/')}`}
                            breadcrumb={breadcrumb}
                            allPhotosForCover={allPhotosForCover}
                            currentCoverId={currentAlbum.coverPhotoId}
                        />
                    </div>
                )}
            </div>

            <div className="space-y-16">
                {/* Child Albums */}
                {hasChildren && (
                    <section>
                        <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-500 mb-6 flex items-center gap-3">
                            Collections in {currentAlbum.name}
                            <div className="h-[1px] flex-1 bg-zinc-800" />
                        </h2>
                        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                            {childAlbumsWithCovers.map((child: any) => (
                                <Link
                                    key={child.id}
                                    href={`/gallery/${slug.join('/')}/${child.slug}`}
                                    className="group relative flex flex-col justify-end aspect-[4/3] rounded-2xl p-6 glass-card overflow-hidden transition-all duration-500"
                                >
                                    {child.coverUrl ? (
                                        <Image
                                            src={child.coverUrl}
                                            alt={child.name}
                                            fill
                                            unoptimized
                                            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                                            className="object-cover opacity-60 group-hover:opacity-80 group-hover:scale-105 transition-all duration-700"
                                        />
                                    ) : (
                                        <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 to-black opacity-40 group-hover:opacity-60 transition-opacity" />
                                    )}
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

                                    <div className="relative z-10">
                                        <p className="text-lg font-bold text-white drop-shadow-lg">{child.name}</p>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </section>
                )}

                {/* Photos */}
                {(hasPhotos || !hasChildren) && (
                    <section>
                        <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-500 mb-6 flex items-center gap-3">
                            {hasVideos ? 'Media' : 'Photography'}
                            <div className="h-[1px] flex-1 bg-zinc-800" />
                        </h2>

                        {!hasPhotos ? (
                            <div className="border border-dashed border-zinc-800 rounded-2xl p-20 text-center">
                                <p className="text-zinc-500 text-lg">No photos uploaded to this collection yet.</p>
                            </div>
                        ) : (
                            <PhotoGrid key={currentAlbum.id} photos={validPhotos as any} isOwner={isOwner} />
                        )}
                    </section>
                )}
            </div>
        </div>
    );
}
