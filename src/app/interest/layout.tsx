import { I18nScope } from '@/i18n/scope';
export default function Layout({ children }: { children: React.ReactNode }) { return <I18nScope scope="interest">{children}</I18nScope>; }
