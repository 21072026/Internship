'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { ProjectForm, type ProjectFormInitial } from '@/components/project/ProjectForm';

// The mentee's own create/edit affordances on /portal/projects (#2270).
//
// The portal page is a server component, so these two tiny clients wrap the
// shared ProjectForm. What they deliberately do NOT offer:
//   - the owner picker: POST /api/projects derives ownership from the session,
//     so a mentee's project is always their own
//   - the contributor-terms picker: its keys endpoint is ADMIN/MENTOR-only and
//     its "don't ask" option would switch the project-level IP gate off
//   - the isPublic checkbox: publishing to the anonymous showcase (and to
//     sitemap.xml, next to the owner's real name) is a programme decision

const shared = { showOwnerPicker: false, showTermsPicker: false, showVisibility: false } as const;

/** "New project" — the entry point a mentee had nowhere before. */
export function PortalProjectCreate({ variant = 'primary' }: { variant?: 'primary' | 'outline' }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <div className="w-full text-left">
        <ProjectForm
          {...shared}
          canEditProtected
          onSaved={() => { setOpen(false); router.refresh(); }}
          onCancel={() => setOpen(false)}
        />
      </div>
    );
  }
  return (
    <Button type="button" variant={variant} onClick={() => setOpen(true)} data-testid="portal-add-project">
      <Plus className="mr-1 h-4 w-4" /> {t.portal.projects.newProject}
    </Button>
  );
}

/** The pencil on a card the mentee owns. Hidden on projects they only work on. */
export function PortalProjectEdit({ project }: { project: ProjectFormInitial }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <ProjectForm
        {...shared}
        project={project}
        canEditProtected
        onSaved={() => { setOpen(false); router.refresh(); }}
        onCancel={() => setOpen(false)}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={t.projects.editProject}
      data-testid={`portal-project-edit-${project.id}`}
      className="p-2 text-gray-400 hover:text-blue-600"
    >
      <Pencil className="h-4 w-4" />
    </button>
  );
}
