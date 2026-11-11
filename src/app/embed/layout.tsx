import { I18nScope } from '@/i18n/scope';

// The Teams tab (#1954, docs/teams-tab-sso.md): no global nav, no chat widget.
// Ships this directory's dictionary namespaces to the browser (#2987). The
// framing headers of every /embed path are set per request by src/middleware.ts.
export default function Layout({ children }: { children: React.ReactNode }) {
  return <I18nScope scope="embed">{children}</I18nScope>;
}
