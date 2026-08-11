/* eslint-disable @next/next/no-img-element */
import { ImageResponse } from 'next/og';
import { prisma } from '@/lib/prisma';

// Next.js route segment config for the OG image endpoint.
export const runtime = 'nodejs';
export const alt = 'Public profile on InternshipCRM';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const BRAND_BLUE = '#1D4ED8';
const BRAND_BLUE_LIGHT = '#EFF6FF';

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;

  const user = await prisma.user.findFirst({
    where: { id: userId, publicProfile: true, role: { in: ['MENTEE', 'MENTOR'] } },
    select: {
      fullName: true,
      displayName: true,
      role: true,
      university: true,
      department: true,
      city: true,
      country: true,
      skills: true,
      targetPosition: true,
      bio: true,
      avatarUrl: true,
    },
  });

  if (!user) {
    // Fallback card for non-public or not-found profiles.
    return new ImageResponse(
      (
        <div
          style={{
            width: 1200,
            height: 630,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: BRAND_BLUE_LIGHT,
            fontFamily: 'sans-serif',
          }}
        >
          <div style={{ color: BRAND_BLUE, fontSize: 48, fontWeight: 700 }}>InternshipCRM</div>
        </div>
      ),
      { width: 1200, height: 630 }
    );
  }

  const headline = user.displayName || user.fullName;
  const location = [user.city, user.country].filter(Boolean).join(', ');
  const skills = (Array.isArray(user.skills) ? (user.skills as string[]) : []).slice(0, 5);
  const isMentor = user.role === 'MENTOR';
  const sub = isMentor ? 'Mentor' : (user.targetPosition ?? user.department ?? user.university ?? '');
  const initials = (headline ?? '?').slice(0, 2).toUpperCase();

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          display: 'flex',
          flexDirection: 'column',
          background: `linear-gradient(135deg, ${BRAND_BLUE_LIGHT} 0%, #E0E7FF 100%)`,
          fontFamily: 'sans-serif',
          padding: 64,
        }}
      >
        {/* Header brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 48 }}>
          <div
            style={{
              width: 40,
              height: 40,
              background: BRAND_BLUE,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{ color: '#fff', fontSize: 22, fontWeight: 700 }}>i</div>
          </div>
          <div style={{ color: BRAND_BLUE, fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
            InternshipCRM
          </div>
        </div>

        {/* Main card */}
        <div
          style={{
            flex: 1,
            background: '#ffffff',
            borderRadius: 24,
            padding: 48,
            display: 'flex',
            alignItems: 'center',
            gap: 48,
            boxShadow: '0 4px 32px rgba(30,64,175,0.10)',
          }}
        >
          {/* Avatar */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.fullName}
                width={140}
                height={140}
                style={{ borderRadius: 20, objectFit: 'cover', border: '3px solid #E0E7FF' }}
              />
            ) : (
              <div
                style={{
                  width: 140,
                  height: 140,
                  background: BRAND_BLUE_LIGHT,
                  borderRadius: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 56,
                  fontWeight: 700,
                  color: BRAND_BLUE,
                  border: '3px solid #E0E7FF',
                }}
              >
                {initials}
              </div>
            )}
          </div>

          {/* Text content */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 52, fontWeight: 800, color: '#111827', letterSpacing: '-1px' }}>
              {headline}
            </div>
            {sub && (
              <div style={{ fontSize: 26, color: BRAND_BLUE, fontWeight: 600 }}>{sub}</div>
            )}
            {location && (
              <div style={{ fontSize: 22, color: '#6B7280', marginTop: 4 }}>{location}</div>
            )}
            {user.bio && (
              <div
                style={{
                  fontSize: 20,
                  color: '#374151',
                  marginTop: 12,
                  lineHeight: 1.4,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {user.bio}
              </div>
            )}
            {skills.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
                {skills.map((s) => (
                  <div
                    key={s}
                    style={{
                      background: BRAND_BLUE_LIGHT,
                      color: BRAND_BLUE,
                      borderRadius: 999,
                      padding: '6px 16px',
                      fontSize: 18,
                      fontWeight: 600,
                    }}
                  >
                    {s}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
