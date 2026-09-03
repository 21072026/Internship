import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(inputs));
}

export type EmptyStateRole = 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY';

/** The one next step an empty screen offers. A link, or a control the screen
 *  already renders anyway (e.g. "new requisition" opening the local dialog). */
export interface EmptyStateAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface EmptyStateRoleCopy {
  /** Overrides `body` for this role. */
  body?: string;
  /** Omit to give this role the explanation without an action. */
  action?: EmptyStateAction;
}

interface EmptyStateProps {
  /** Rendered as `data-testid="empty-<testId>"`. */
  testId: string;
  title: string;
  /** One sentence of orientation plus one of what happens next. */
  body?: string;
  icon?: LucideIcon;
  /** The viewer's role. `null`/`undefined` falls back to the role-neutral copy. */
  role?: EmptyStateRole | string | null;
  /**
   * Per-role copy and action. **When this is given, the action comes only from
   * the matching entry** — a role with no entry (or an unknown role) gets the
   * explanation and no button, which is what keeps this component from ever
   * offering a route the viewer would be refused by.
   */
  byRole?: Partial<Record<EmptyStateRole, EmptyStateRoleCopy>>;
  /** Role-neutral action, used only when `byRole` is not given. */
  action?: EmptyStateAction;
  /** `sm` for an inline slot (a board column, a panel section). */
  size?: 'sm' | 'md';
  className?: string;
}

// Every screen with nothing in it either teaches or disappoints. This is the
// one component that turns "no rows" into a next step, and the step depends on
// who is looking: an admin staring at an empty board is told to invite people,
// a mentor is told their mentees appear here once an admin assigns them —
// never a button that walks into a 403.
//
// Purely presentational: it renders a link, and the route behind the link does
// its own authorization. Deliberately not a client component, so server pages
// (e.g. /portal/goals) can render it directly.
export function EmptyState({
  testId,
  title,
  body,
  icon: Icon = Inbox,
  role,
  byRole,
  action,
  size = 'md',
  className,
}: EmptyStateProps) {
  const roleCopy = byRole && role ? byRole[role as EmptyStateRole] : undefined;
  const text = roleCopy?.body ?? body;
  const cta = byRole ? roleCopy?.action : action;

  // Flat `html.dark` overrides in globals.css already retint bg-gray-100 →
  // gray-700 and text-gray-500/900, and they outrank `dark:` variants — so
  // these plain utilities are the ones that actually behave in both themes.
  const ctaClass =
    'inline-flex min-h-11 items-center justify-center gap-2 mt-4 px-4 py-2 rounded-lg bg-blue-600 text-white ' +
    'text-sm font-medium transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2';

  return (
    <div
      data-testid={`empty-${testId}`}
      className={cn('text-center px-4', size === 'sm' ? 'py-8' : 'py-14', className)}
    >
      <div
        className={cn(
          'mx-auto rounded-2xl bg-gray-100 flex items-center justify-center',
          size === 'sm' ? 'w-9 h-9 mb-3' : 'w-12 h-12 mb-4'
        )}
      >
        <Icon aria-hidden="true" className={cn('text-gray-400', size === 'sm' ? 'h-5 w-5' : 'h-6 w-6')} />
      </div>
      <p className={cn('font-medium text-gray-900', size === 'sm' ? 'text-sm' : '')}>{title}</p>
      {text && <p className="text-gray-500 text-sm mt-1 max-w-md mx-auto">{text}</p>}
      {cta?.href && (
        <Link href={cta.href} className={ctaClass}>
          {cta.label}
        </Link>
      )}
      {cta && !cta.href && cta.onClick && (
        <button type="button" onClick={cta.onClick} className={ctaClass}>
          {cta.label}
        </button>
      )}
    </div>
  );
}
