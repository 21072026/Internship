'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs overflow-x-auto whitespace-pre">
      <code>{children}</code>
    </pre>
  );
}

export default function ApiDocsPage() {
  const t = useT();
  const [base, setBase] = useState('https://crm.ersah.in');

  useEffect(() => {
    setBase(window.location.origin);
  }, []);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.apiDocs.title}</h1>
        <p className="text-gray-500 mt-1">{t.apiDocs.subtitle}</p>
      </div>

      <div className="space-y-6 max-w-3xl">
        <Card>
          <CardHeader><CardTitle>{t.apiDocs.auth}</CardTitle></CardHeader>
          <p className="text-sm text-gray-600 mb-3">{t.apiDocs.authHint}</p>
          <Code>{`Authorization: Bearer icrm_xxxxxxxxxxxxxxxxxxxx`}</Code>
          <p className="text-xs text-gray-500 mt-2">{t.apiDocs.rateLimit}</p>
        </Card>

        <Card>
          <CardHeader><CardTitle>GET /api/v1/candidates</CardTitle></CardHeader>
          <p className="text-sm text-gray-600 mb-3">{t.apiDocs.candidatesHint}</p>
          <p className="text-xs font-medium text-gray-700 mb-1">{t.apiDocs.request}</p>
          <Code>{`curl -H "Authorization: Bearer icrm_..." \\
  ${base}/api/v1/candidates`}</Code>
          <p className="text-xs font-medium text-gray-700 mb-1 mt-4">{t.apiDocs.response}</p>
          <Code>{`{
  "candidates": [
    {
      "id": "clx...",
      "fullName": "Ayşe Yılmaz",
      "university": "Boğaziçi",
      "department": "Computer Science",
      "graduationYear": 2026,
      "skills": ["React", "Python"],
      "stage": "INTERNSHIP_IN_PROGRESS_450"
    }
  ]
}`}</Code>
          <p className="text-xs text-gray-500 mt-2">{t.apiDocs.noPii}</p>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t.apiDocs.openapi}</CardTitle></CardHeader>
          <p className="text-sm text-gray-600 mb-2">{t.apiDocs.openapiHint}</p>
          <a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline">
            {base}/api/v1/openapi.json
          </a>
        </Card>
      </div>
    </div>
  );
}
