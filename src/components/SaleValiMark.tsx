import { useId } from 'react';

// The SaleVali brand mark (the "V" with the gold→orange gradient), cropped from
// salevali.de's logo SVG to a square viewBox with ~6% padding — the wordmark is
// deliberately absent; the app renders the product name as text next to it.
//
// The gradient ids are suffixed with React's useId() so two instances on one
// page (nav + footer, or an icon inside a list) do not collide: an SVG
// `url(#id)` is document-global, and duplicated ids make every copy read the
// FIRST gradient's coordinates — which, with userSpaceOnUse units, is the wrong
// colour for any copy that is not at the same page position. useId is stable
// across SSR/hydration and works in both server and client components.
//
// Gradients are kept verbatim (userSpaceOnUse + gradientTransform), so the
// colours are identical to the brand file — do not "simplify" them to
// objectBoundingBox, the orange tail would move.
export interface SaleValiMarkProps {
  className?: string;
  /** Optional <title> for a native tooltip; the accessible name stays "SaleVali". */
  title?: string;
}

export function SaleValiMark({ className, title }: SaleValiMarkProps) {
  // useId() tokens are `_R_<base32>_` on React 19.2 (this repo), `«r0»` on 19.1
  // and `:r0:` on 18 — strip everything outside [A-Za-z0-9_-] so the id is safe
  // inside url(#…) on any of them; the variable part survives, so it stays unique.
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const g1 = `sv-g1-${uid}`;
  const g2 = `sv-g2-${uid}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-10.3 -27.13 193.26 193.26"
      role="img"
      aria-label="SaleVali"
      className={className}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient
          id={g1}
          y1="325.5"
          x2="1"
          y2="325.5"
          gradientTransform="matrix(78.15, 0, 0, -78.15, 72.04, 25444.68)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#f5bd63" />
          <stop offset="1" stopColor="#e36f2b" />
        </linearGradient>
        <linearGradient
          id={g2}
          y1="325.5"
          x2="1"
          y2="325.5"
          gradientTransform="matrix(146.5, 20.8, 20.8, -146.5, -6802.8, 47743.15)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#f5bd63" />
          <stop offset="0.6" stopColor="#f5bd63" />
          <stop offset="1" stopColor="#e36f2b" />
        </linearGradient>
      </defs>
      <path
        d="M76.19,0a4.15,4.15,0,0,0-3.48,6.4L78,14.58A1.69,1.69,0,0,1,79.42,12h63.43a1.7,1.7,0,0,1,1.43,2.62l5.25-8.19A4.16,4.16,0,0,0,146,0Z"
        fill={`url(#${g1})`}
      />
      <path
        d="M12.15,0A12.13,12.13,0,0,0,2,18.72L76.12,133.44A12,12,0,0,0,86.56,139h0a12.31,12.31,0,0,0,5.51-1.43l.16-.1a10.29,10.29,0,0,0,1.09-.67c.12-.08.23-.19.34-.27.28-.22.56-.43.82-.67s.37-.37.55-.56.36-.35.52-.55a11.17,11.17,0,0,0,1-1.28l6.92-10.7a21.59,21.59,0,0,0,0-23.44L100.61,95l0,.09a8.4,8.4,0,0,1,.79,7.29,8.78,8.78,0,0,1-.84,1.75l-4.69,7.24a2.81,2.81,0,0,1-4.74,0L22.79,5.55A12.12,12.12,0,0,0,12.6,0Z"
        fill={`url(#${g2})`}
      />
      <path
        d="M88.56,30.92,78,14.58,72.71,6.41A4.16,4.16,0,0,1,76.19,0H61.52A12.13,12.13,0,0,0,51.33,18.72L100.61,95a9,9,0,0,1,.53,1,7.37,7.37,0,0,0-.48-.87l0-.09,2.81,4.34a21.59,21.59,0,0,1,0,23.44l16.18-25a17.3,17.3,0,0,0,0-18.77l-31-48Z"
        fill="#f4bc63"
      />
      <path
        d="M160.47,0H146a4.15,4.15,0,0,1,3.49,6.39l-5.24,8.19h0L125.46,43.94a12.14,12.14,0,0,0,20.41,13.14l24.79-38.36A12.13,12.13,0,0,0,160.47,0Z"
        fill="#f4bc63"
      />
    </svg>
  );
}

export default SaleValiMark;
