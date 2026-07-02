import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GraduationCap, Github, ExternalLink, Trello } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';

export const dynamic = 'force-dynamic';

// Public, PII-free detail for a project opted into the showcase.
export default async function PublicProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t } = await getServerDictionary();
  const p = await prisma.project.findFirst({
    where: { id, isPublic: true },
    select: {
      name: true, description: true, technologies: true, repoUrl: true, demoUrl: true, boardUrl: true, status: true,
      ownerType: true, ownerUser: { select: { fullName: true } }, ownerCompany: { select: { name: true } },
      _count: { select: { relations: true } },
    },
  });
  if (!p) notFound();
  const tech = Array.isArray(p.technologies) ? (p.technologies as string[]) : [];
  const owner = p.ownerType === 'COMPANY' ? p.ownerCompany?.name : p.ownerUser?.fullName;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <Link href="/projects" className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6">
          <GraduationCap className="h-4 w-4 text-blue-600" /> {t.projects.showcaseTitle}
        </Link>
        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <h1 className="text-2xl font-bold text-gray-900">{p.name}</h1>
          {owner && <p className="text-sm text-gray-500 mt-1">{t.projects.by} {owner}</p>}
          {p.description && <p className="text-gray-700 mt-4 whitespace-pre-wrap">{p.description}</p>}
          {tech.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-5">
              {tech.map((x) => <span key={x} className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 text-sm">{x}</span>)}
            </div>
          )}
          <div className="flex gap-4 mt-6 text-sm">
            {p.repoUrl && <a href={p.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Github className="h-4 w-4" />{t.projects.repo}</a>}
            {p.demoUrl && <a href={p.demoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><ExternalLink className="h-4 w-4" />{t.projects.demo}</a>}
            {p.boardUrl && <a href={p.boardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline"><Trello className="h-4 w-4" />{t.projects.board}</a>}
          </div>
          <p className="text-xs text-gray-400 mt-6">{p._count.relations} {t.projects.members}</p>
        </div>
      </div>
    </div>
  );
}
