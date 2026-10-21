import { BrandProvider } from '@/lib/brandClient';
import { invitationBrand } from '@/lib/invitationBrand';
import RegisterClient from './RegisterClient';

// The invitation landing wears the inviting organization's brand (#1663): an
// invitee arrives on the default host with nothing but `?token=`, so the
// request's own brand (host, session) is the default one. A live invitation of
// this host's world overrides it for this page; anything else (no token, an
// unknown, used, expired, revoked or other-world one) leaves the request's
// brand as it was — the same answer, so the page says nothing about a token.
export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  const brand = await invitationBrand(typeof token === 'string' ? token : null);
  return brand ? (
    <BrandProvider brand={brand}>
      <RegisterClient />
    </BrandProvider>
  ) : (
    <RegisterClient />
  );
}
