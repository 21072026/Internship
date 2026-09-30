import { prisma } from '@/lib/prisma';
import { OG_CONTENT_TYPE, OG_SIZE, renderCard } from '@/lib/ogCard';

// Share card for a project (#1378): its name and technologies — and only for
// a PUBLIC project. Any other id, private or nonexistent, gets the same generic
// brand card, so the image never says whether an id exists or what a private
// project is called (the /p/[userId] card's rule).
export const runtime = 'nodejs';
export const alt = 'Project';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function OpengraphImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, isPublic: true },
    select: { name: true, technologies: true },
  });
  if (!project) return renderCard(null);
  const technologies = Array.isArray(project.technologies)
    ? project.technologies.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  return renderCard({ title: project.name, chips: technologies });
}
