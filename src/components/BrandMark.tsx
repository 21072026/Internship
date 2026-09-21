'use client';

import { GraduationCap } from 'lucide-react';
import { useVertical } from '@/lib/verticalClient';
import { SaleValiMark } from '@/components/SaleValiMark';

// The product mark for the request's vertical (#2356). INTERNSHIP keeps the
// graduation cap it always had; a MARKETING host shows the SaleVali "V". Reads
// the vertical from the seam the root layout provides, so a client component
// (PublicHeader, the auth pages) and a server component (BrandWordmark,
// PublicFooter) render the same mark without threading props.
//
// The SaleVali mark carries its own gold→orange fills and ignores currentColor,
// so a `text-blue-600` class passed for the cap is harmless on it.
export function BrandMark({ className }: { className?: string }) {
  const vertical = useVertical();
  if (vertical === 'MARKETING') return <SaleValiMark className={className} />;
  return <GraduationCap className={className} />;
}

// The 56px tile at the top of the auth pages (sign-in, register, forgot, reset,
// verify). The cap sits white on the accent-600 tile; the SaleVali mark is gold
// on the brand's deep purple (#1a0a2e — 10.9:1 for the gold, 5.8:1 for the
// orange tail), never on the magenta primary, where the orange vanishes.
export function BrandTile() {
  const vertical = useVertical();
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
