'use client';
import { useT } from "@/i18n/client";

import { useCallback, useRef, useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { COMPANY_SORT_KEYS, DEFAULT_COMPANY_SORT, type CompanySort } from '@/lib/companySort';


import { CompanyForm } from '@/components/forms/CompanyForm';
import { CompanyEntitlements } from '@/components/admin/CompanyEntitlements';
import { Building2, Plus, Pencil, Trash2, Search, Sparkles } from 'lucide-react';

interface Company {
  id: string;
  name: string;
  description?: string;
  contactEmail?: string;
  industry?: string;
  needs: { id: string; position: string; count: number; period: string }[];
  _count: { mentorships: number };
}

const PAGE_SIZE = 24;

export default function CompaniesPage() {
  const t = useT();
  const [companies, setCompanies] = useState<Company[]>([]);
  // The company <select> below provisions a login and must offer EVERY company,
  // not the page currently on screen — so it reads the same route with `all=1`
  // rather than borrowing the paged list (#2437).
  //
  // ON DEMAND, not on mount. Paging the grid is pointless if the screen behind
  // it still downloads the whole account book on every visit: with 800 accounts
  // that unbounded read is the cost #2437 exists to remove, and it would have
  // been paid by every admin who opened this page and never touched the login
  // form. It now fires the first time the picker is actually used (focus covers
  // both mouse and keyboard), and refreshes afterwards only if it was loaded.
  const [allCompanies, setAllCompanies] = useState<{ id: string; name: string }[]>([]);
  const allLoadedRef = useRef(false);
  /** Which company the in-flight delete-impact request was asked about. */
  const impactForRef = useRef<string | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<CompanySort>(DEFAULT_COMPANY_SORT);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [impact, setImpact] = useState<{
    cascade: Record<string, number>;
    detach: Record<string, number>;
  } | null>(null);
  const [impactFailed, setImpactFailed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [entitlingCompany, setEntitlingCompany] = useState<Company | null>(null);
  const [error, setError] = useState('');
  const [clCompanyId, setClCompanyId] = useState('');
  const [clEmail, setClEmail] = useState('');
  const [clName, setClName] = useState('');
  const [clMsg, setClMsg] = useState('');
  const [clBusy, setClBusy] = useState(false);
  const closeCompanyForm = () => {
    setShowForm(false);
    setEditingCompany(null);
  };
  const companyDialogRef = useModalFocus<HTMLDivElement>(showForm || editingCompany !== null, closeCompanyForm);

  const createCompanyLogin = async () => {
    setClBusy(true);
    setClMsg('');
    try {
      const res = await fetch('/api/admin/company-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: clCompanyId, email: clEmail, fullName: clName }),
      });
      const data = await res.json();
      // A created account whose set-password email never sent is unreachable —
      // say so instead of reporting plain success (#987).
      setClMsg(
        res.ok
          ? data.emailSent === false
            ? t.companiesPage.loginCreatedNoEmail
            : t.companiesPage.loginCreated
          : data.error || t.common.error
      );
      if (res.ok) {
        setClEmail('');
        setClName('');
      }
    } finally {
      setClBusy(false);
    }
  };

  // Search, ordering and paging are all decided by the server (#2436/#2437):
  // the page asks for one page of rows and renders exactly what comes back.
  // There is deliberately no client-side `filter()` or re-sort left — with a
  // page of 24 rows, filtering in the browser would hide matches that are on
  // another page and quietly turn "search" into "search this screen".
  const fetchCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        sort,
      });
      if (search.trim()) params.set('search', search.trim());
      const res = await fetch(`/api/companies?${params}`);
      const data = await res.json();
      setCompanies(data.companies || []);
      setTotal(typeof data.total === 'number' ? data.total : (data.companies?.length ?? 0));
    } catch {
      setError(t.companiesPage.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [page, search, sort, t]);

  const fetchAllCompanies = useCallback(async () => {
    try {
      allLoadedRef.current = true;
      const res = await fetch('/api/companies?all=1');
      const data = await res.json();
      setAllCompanies(data.companies || []);
    } catch {
      /* The login picker is secondary; the list above already reports failures. */
    }
  }, []);

  /** First use of the picker loads it; later uses reuse what is already there. */
  const loadPickerOnce = useCallback(() => {
    if (!allLoadedRef.current) void fetchAllCompanies();
  }, [fetchAllCompanies]);

  /** A create/update/delete only has to refresh a picker somebody opened. */
  const refreshPickerIfLoaded = useCallback(
    () => (allLoadedRef.current ? fetchAllCompanies() : Promise.resolve()),
    [fetchAllCompanies]
  );

  useEffect(() => {
    const timeout = setTimeout(fetchCompanies, 300);
    return () => clearTimeout(timeout);
  }, [fetchCompanies]);

  // A new search term or a different order restarts at page 1 — page 4 of the
  // previous result set is an empty screen with no explanation.
  useEffect(() => {
    setPage(1);
  }, [search, sort]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleCreate = async (data: {
    name: string;
    description?: string;
    contactEmail?: string;
    industry?: string;
    needs?: { position: string; count: number; period: string }[];
  }) => {
    const res = await fetch('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error || t.companiesPage.createFailed);
    }
    await Promise.all([fetchCompanies(), refreshPickerIfLoaded()]);
    setShowForm(false);
  };

  const handleUpdate = async (data: {
    name?: string;
    description?: string;
    contactEmail?: string;
    industry?: string;
    needs?: { position: string; count: number; period: string }[];
  }) => {
    if (!editingCompany) return;
    const res = await fetch(`/api/companies/${editingCompany.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error || t.companiesPage.updateFailed);
    }
    await Promise.all([fetchCompanies(), refreshPickerIfLoaded()]);
    setEditingCompany(null);
  };

  // Deleting an account is the one action on this page that cannot be undone,
  // and the native `confirm()` it used to go through could only repeat the
  // company's name back (#2441). The dialog now states the consequences the
  // schema actually produces — what cascades away with the row, and what stays
  // behind with its company link cleared — with the counts fetched first.
  const dd = t.companiesPage.deleteDialog;

  const askDelete = async (company: Company) => {
    // The counts are fetched per company and arrive whenever they arrive. Open
    // A, cancel, open B, and A's slower answer would otherwise land in B's
    // dialog — one account's consequences under another account's name, one
    // click before an irreversible delete. Every answer is therefore tagged
    // with the account it was asked about and a late one is dropped.
    impactForRef.current = company.id;
    setPendingDelete({ id: company.id, name: company.name });
    setImpact(null);
    setImpactFailed(false);
    try {
      const res = await fetch(`/api/companies/${company.id}/delete-impact`);
      if (!res.ok) throw new Error('impact');
      const data = await res.json();
      if (impactForRef.current !== company.id) return;
      setImpact({ cascade: data.impact?.cascade ?? {}, detach: data.impact?.detach ?? {} });
    } catch {
      // Say that the counts are missing rather than showing a dialog that
      // silently implies "nothing is linked".
      if (impactForRef.current !== company.id) return;
      setImpactFailed(true);
    }
  };

  const closeDeleteDialog = () => {
    impactForRef.current = null;
    setPendingDelete(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/companies/${pendingDelete.id}`, { method: 'DELETE' });
      if (!res.ok) setError(t.common.deleteFailed);
      closeDeleteDialog();
      await Promise.all([fetchCompanies(), refreshPickerIfLoaded()]);
    } finally {
      setDeleting(false);
    }
  };

  const impactItems = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([key, count]) =>
        dd.item
          .replace('{count}', String(count))
          .replace('{label}', dd.labels[key as keyof typeof dd.labels] ?? key)
      )
      .join(', ');

  const cascadeItems = impact ? impactItems(impact.cascade) : '';
  const detachItems = impact ? impactItems(impact.detach) : '';

  return (
    <div>
      {/* Wraps on a phone: "Unternehmen hinzufügen" next to the title pushed the
          button 9px past the content column in German (#1305). */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.companiesPage.title}</h1>
          <p className="text-gray-500 mt-1">{t.companiesPage.subtitle}</p>
        </div>
        <Button onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4" />
          {t.companiesPage.addCompany}
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Provision a read-only company login */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t.companiesPage.addLogin}</CardTitle>
          <CardDescription>{t.companiesPage.addLoginHint}</CardDescription>
        </CardHeader>
        {clMsg && <p className="text-sm text-gray-700 mb-3">{clMsg}</p>}
        <div className="flex flex-wrap items-end gap-2">
          <select
            data-testid="company-login-picker"
            value={clCompanyId}
            onFocus={loadPickerOnce}
            onChange={(e) => setClCompanyId(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            <option value="">{t.companiesPage.selectCompany}</option>
            {allCompanies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label={t.companiesPage.loginName}
            placeholder={t.companiesPage.loginName}
            value={clName}
            onChange={(e) => setClName(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="email"
            aria-label={t.companiesPage.loginEmail}
            placeholder={t.companiesPage.loginEmail}
            value={clEmail}
            onChange={(e) => setClEmail(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <Button
            type="button"
            loading={clBusy}
            disabled={!clCompanyId || !clEmail || !clName}
            onClick={createCompanyLogin}
          >
            {t.companiesPage.createLogin}
          </Button>
        </div>
      </Card>

      {/* Create/Edit Modal */}
      {(showForm || editingCompany) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div
            ref={companyDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="company-form-title"
            tabIndex={-1}
            className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto"
          >
            <h2 id="company-form-title" className="text-xl font-bold text-gray-900 mb-6">
              {editingCompany ? t.companiesPage.editCompany : t.companiesPage.addCompany}
            </h2>
            <CompanyForm
              defaultValues={editingCompany || undefined}
              onSubmit={editingCompany ? handleUpdate : handleCreate}
              onCancel={closeCompanyForm}
              isEditing={!!editingCompany}
            />
          </div>
        </div>
      )}

      {/* Premium entitlements modal */}
      {entitlingCompany && (
        <CompanyEntitlements
          companyId={entitlingCompany.id}
          companyName={entitlingCompany.name}
          onClose={() => setEntitlingCompany(null)}
        />
      )}

      {/* Delete confirmation (#2441) — replaces the browser's confirm(). */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={dd.title}
        variant="danger"
        loading={deleting}
        confirmLabel={dd.confirm}
        cancelLabel={t.common.cancel}
        onConfirm={confirmDelete}
        onCancel={closeDeleteDialog}
        message={
          pendingDelete ? (
            <>
              <p>{dd.intro.replace('{name}', pendingDelete.name)}</p>
              {impactFailed && (
                <p className="mt-2" data-testid="company-delete-impact-failed">
                  {dd.impactFailed}
                </p>
              )}
              {impact && (
                <>
                  {cascadeItems && (
                    <p className="mt-2" data-testid="company-delete-cascade">
                      {dd.cascade.replace('{items}', cascadeItems)}
                    </p>
                  )}
                  {detachItems && (
                    <p className="mt-2" data-testid="company-delete-detach">
                      {dd.detach.replace('{items}', detachItems)}
                    </p>
                  )}
                  {!cascadeItems && !detachItems && (
                    <p className="mt-2" data-testid="company-delete-nothing-else">
                      {dd.nothingElse}
                    </p>
                  )}
                </>
              )}
            </>
          ) : (
            ''
          )
        }
      />

      {/* Search + order. Both are query parameters on /api/companies — the
          search box has its own testid because AdminNav renders a sidebar
          input[type="search"] on every admin page. */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 min-w-[12rem]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            data-testid="companies-search"
            placeholder={t.companiesPage.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          />
        </div>
        <select
          data-testid="companies-sort"
          aria-label={t.companiesPage.sortLabel}
          value={sort}
          onChange={(e) => setSort(e.target.value as CompanySort)}
          className="px-3 py-2.5 border border-gray-300 rounded-lg text-sm"
        >
          {COMPANY_SORT_KEYS.map((key) => (
            <option key={key} value={key}>
              {t.companiesPage.sortOptions[key]}
            </option>
          ))}
        </select>
        <span className="text-sm text-gray-500" data-testid="companies-total">
          {t.companiesPage.resultCount.replace('{count}', String(total))}
        </span>
      </div>

      {/* Companies Grid */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">{t.common.loading}</div>
      ) : companies.length === 0 ? (
        <Card>
          <EmptyState
            testId="admin-companies"
            icon={Building2}
            role="ADMIN"
            title={t.emptyStates.companies.title}
            byRole={{
              ADMIN: {
                body: t.emptyStates.companies.adminBody,
                // The create form is a dialog on this very page, so the next
                // step is the control the screen already renders.
                action: { label: t.emptyStates.companies.adminCta, onClick: () => setShowForm(true) },
              },
            }}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6" data-testid="companies-list">
          {companies.map((company) => (
            <Card key={company.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle>{company.name}</CardTitle>
                    {company.industry && (
                      <CardDescription>{company.industry}</CardDescription>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setEntitlingCompany(company)}
                      title={t.entitlements.title}
                      aria-label={t.entitlements.title}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-blue-600 transition-colors"
                    >
                      <Sparkles className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setEditingCompany(company)}
                      data-testid={`edit-company-${company.id}`}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => askDelete(company)}
                      data-testid={`delete-company-${company.id}`}
                      title={dd.title}
                      aria-label={dd.title}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </CardHeader>

              {company.description && (
                <p className="text-sm text-gray-600 mb-4 line-clamp-2">{company.description}</p>
              )}

              {company.contactEmail && (
                <p className="text-xs text-gray-500 mb-3">📧 {company.contactEmail}</p>
              )}

              <div className="flex items-center gap-2 mb-4">
                <Badge variant="info">{company._count.mentorships} {t.companiesPage.mentorships}</Badge>
                <Badge variant="default">{company.needs.length} {t.companiesPage.positions}</Badge>
              </div>

              {company.needs.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                    {t.companiesPage.openPositions}
                  </p>
                  <div className="space-y-1.5">
                    {company.needs.map((need) => (
                      <div
                        key={need.id}
                        className="flex items-center justify-between text-xs bg-gray-50 rounded-lg px-3 py-2"
                      >
                        <span className="font-medium text-gray-700">{need.position}</span>
                        <span className="text-gray-500">
                          {need.count} × {need.period}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-8" data-testid="companies-pagination">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            {t.common.prev}
          </Button>
          <span className="text-sm text-gray-500">{page} / {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            {t.common.next}
          </Button>
        </div>
      )}
    </div>
  );
}
