'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
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

/** Longest the form waits for the refreshed list before closing anyway. */
const REFRESH_WAIT_MS = 15_000;

/**
 * `onSaved` for a form whose result only exists in the server-rendered list
 * (#2481). The list is in the RSC payload of a `router.refresh()`, and nothing
 * on the client inserts the saved row, so closing the form and firing the
 * refresh off left a window — seconds long on a loaded server — in which the
 * form was gone and the list still showed the old state. The refresh now runs
 * in a transition and the returned promise settles once it has committed:
 * ProjectForm awaits it with its button still busy, so the form closes on the
 * list that already carries the change, and a second click cannot re-submit.
 */
function useSaveThenRefresh(close: () => void) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const settle = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!pending && settle.current) {
      settle.current();
      settle.current = null;
    }
  }, [pending]);

  return useCallback(
    () =>
      new Promise<void>((resolve) => {
        // A refresh that never commits must not strand the form open.
        const fallback = setTimeout(() => { settle.current = null; resolve(); }, REFRESH_WAIT_MS);
        settle.current = () => { clearTimeout(fallback); resolve(); };
        startTransition(() => router.refresh());
      }).then(close),
    [router, close]
  );
}

/** "New project" — the entry point a mentee had nowhere before. */
export function PortalProjectCreate({ variant = 'primary' }: { variant?: 'primary' | 'outline' }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const onSaved = useSaveThenRefresh(useCallback(() => setOpen(false), []));

  if (open) {
    return (
      <div className="w-full text-left">
        <ProjectForm
          {...shared}
          canEditProtected
          onSaved={onSaved}
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
  const [open, setOpen] = useState(false);
  const onSaved = useSaveThenRefresh(useCallback(() => setOpen(false), []));

  if (open) {
    return (
      <ProjectForm
        {...shared}
        project={project}
        canEditProtected
        onSaved={onSaved}
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
