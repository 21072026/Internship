'use client';

import { GraduationCap } from 'lucide-react';
import { useVertical } from '@/lib/verticalClient';
import { useBrand } from '@/lib/brandClient';
import { SaleValiMark } from '@/components/SaleValiMark';

// The product mark for the request's vertical (#2492). INTERNSHIP keeps the
// graduation cap it always had; a MARKETING host shows the SaleVali "V". Reads
// the vertical from the seam the root layout provides, so a client component
// (PublicHeader, the auth pages) and a server component (BrandWordmark,
// PublicFooter) render the same mark without threading props.
//
// The SaleVali mark carries its own gold→orange fills and ignores currentColor,
// so a `text-blue-600` class passed for the cap is harmless on it.
export function BrandMark({ className }: { className?: string }) {
  const vertical = useVertical();
  // An organization's uploaded mark (#2922) — the signed-in person's own
  // organization, else the host's (src/lib/hostBrand.ts). Decorative: the
  // product name always sits next to it as text. Without one, the built-in
  // mark below is unchanged.
  const brand = useBrand();
  if (brand?.markSrc) {
    // eslint-disable-next-line @next/next/no-img-element -- a generated, versioned PNG served by /brand/<v>/…
    return <img src={brand.markSrc} alt="" aria-hidden="true" data-brand-mark="" className={className} />;
  }
  if (vertical === 'MARKETING') return <SaleValiMark className={className} />;
  return <GraduationCap className={className} />;
}

// The 56px tile at the top of the auth pages (sign-in, register, forgot, reset,
// verify). The cap sits white on the accent-600 tile; the SaleVali mark is gold
// on the brand's deep purple (#1a0a2e — 10.9:1 for the gold, 5.8:1 for the
// orange tail), never on the magenta primary, where the orange vanishes.
export function BrandTile() {
  const vertical = useVertical();
  // An organization's mark sits on its own tile colour (#2922), in the same
  // 56px tile and 36px glyph box as the built-in mark below.
  const brand = useBrand();
  if (brand?.markSrc) {
    return (
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: brand.tileColor }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a generated, versioned PNG served by /brand/<v>/… */}
        <img src={brand.markSrc} alt="" aria-hidden="true" data-brand-mark="" className="h-9 w-9" />
      </div>
    );
  }
  if (vertical === 'MARKETING') {
    return (
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-[#1a0a2e]">
        <SaleValiMark className="h-9 w-9" />
      </div>
    );
  }
  return (
    <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center">
      <GraduationCap className="h-8 w-8 text-white" />
    </div>
  );
}
