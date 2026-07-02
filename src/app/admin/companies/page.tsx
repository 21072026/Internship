'use client';
import { useT } from "@/i18n/client";

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';


import { CompanyForm } from '@/components/forms/CompanyForm';
import { Building2, Plus, Pencil, Trash2, Search } from 'lucide-react';

interface Company {
  id: string;
  name: string;
  description?: string;
  contactEmail?: string;
  industry?: string;
  needs: { id: string; position: string; count: number; period: string }[];
  _count: { mentorships: number };
}

export default function CompaniesPage() {
  const t = useT();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [error, setError] = useState('');
  const [clCompanyId, setClCompanyId] = useState('');
  const [clEmail, setClEmail] = useState('');
  const [clName, setClName] = useState('');
  const [clMsg, setClMsg] = useState('');
  const [clBusy, setClBusy] = useState(false);

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
      setClMsg(res.ok ? t.companiesPage.loginCreated : data.error || 'Failed');
      if (res.ok) {
        setClEmail('');
        setClName('');
      }
    } finally {
      setClBusy(false);
    }
  };

  const fetchCompanies = async () => {
    try {
      const res = await fetch('/api/companies');
      const data = await res.json();
      setCompanies(data.companies || []);
    } catch {
      setError('Failed to load companies');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCompanies();
  }, []);

  const filteredCompanies = companies.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.industry?.toLowerCase().includes(search.toLowerCase())
  );

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
      throw new Error(body.error || 'Failed to create company');
    }
    await fetchCompanies();
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
      throw new Error(body.error || 'Failed to update company');
    }
    await fetchCompanies();
    setEditingCompany(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this company?')) return;
    await fetch(`/api/companies/${id}`, { method: 'DELETE' });
    await fetchCompanies();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.companiesPage.title}</h1>
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
            value={clCompanyId}
            onChange={(e) => setClCompanyId(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            <option value="">{t.companiesPage.selectCompany}</option>
            {companies.map((c) => (
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
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-gray-900 mb-6">
              {editingCompany ? t.companiesPage.editCompany : t.companiesPage.addCompany}
            </h2>
            <CompanyForm
              defaultValues={editingCompany || undefined}
              onSubmit={editingCompany ? handleUpdate : handleCreate}
              onCancel={() => {
                setShowForm(false);
                setEditingCompany(null);
              }}
              isEditing={!!editingCompany}
            />
          </div>
        </div>
      )}

      {/* Search */}
      <div className="mb-6">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder={t.companiesPage.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
          />
        </div>
      </div>

      {/* Companies Grid */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">{t.common.loading}</div>
      ) : filteredCompanies.length === 0 ? (
        <Card className="text-center py-12">
          <Building2 className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">{t.companiesPage.none}</p>
          <Button onClick={() => setShowForm(true)} variant="outline" className="mt-4">
            <Plus className="h-4 w-4" />
            {t.companiesPage.addFirstCompany}
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {filteredCompanies.map((company) => (
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
                      onClick={() => setEditingCompany(company)}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(company.id)}
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
    </div>
  );
}
