import type { Metadata } from 'next';
import { brandSplashLinks } from '@/lib/appleSplash';
import { brandAssetPath } from '@/lib/brandRule';
import type { ResolvedBrand } from '@/lib/hostBrand';

/**
 * Dress the root layout's metadata in a HOST's organization brand (#2922): the
 * name an installed app carries (application-name, the iOS home-screen title)
 * and, when the organization has a generated icon set, its favicon,
 * apple-touch icon and the iOS launch images — the same files the manifest
 * (src/app/manifest.ts) installs, so a tab, a home-screen icon and an install
 * never disagree.
 *
 * Called ONLY for `brand.source === 'org'`. A default brand never reaches this
 * function, which is what keeps the built-in metadata byte-identical. Fields
 * the organization left empty already carry the default (brandRule.ts), and an
 * organization without an icon set keeps the vertical's static icons.
 */
export function applyHostBrandMetadata(metadata: Metadata, brand: ResolvedBrand): void {
  metadata.applicationName = brand.productName;
  const apple = typeof metadata.appleWebApp === 'object' && metadata.appleWebApp !== null ? metadata.appleWebApp : {};
  metadata.appleWebApp = { ...apple, title: brand.productName };
  if (!brand.markVersion || !brand.assetBase) return;
  const v = brand.markVersion;
  metadata.icons = {
    icon: [
      { url: brandAssetPath(v, 'favicon-32'), type: 'image/png', sizes: '32x32' },
      { url: brandAssetPath(v, 'icon-192'), type: 'image/png', sizes: '192x192' },
    ],
    apple: brandAssetPath(v, 'apple-touch-icon'),
    other: brandSplashLinks(brand.assetBase),
  };
}
