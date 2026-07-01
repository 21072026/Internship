'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';

// A 1–5 star self-assessment picker, replacing the old numeric <select>.
// Click a star to set the level; click the current level again to clear it.
// Keyboard-accessible (arrow keys) and dark-mode aware.
export function SkillRating({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  label?: string;
}) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;

  return (
    <div
      className="flex items-center gap-0.5"
      role="radiogroup"
      aria-label={label}
      onMouseLeave={() => setHover(0)}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const active = n <= shown;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n}/5`}
            onMouseEnter={() => setHover(n)}
            onClick={() => onChange(value === n ? 0 : n)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); onChange(Math.min(5, value + 1)); }
              if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(Math.max(0, value - 1)); }
            }}
            className="p-0.5 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <Star
              className={`h-5 w-5 transition-colors ${
                active
                  ? 'fill-amber-400 text-amber-400'
                  : 'fill-transparent text-gray-300 dark:text-gray-600 hover:text-amber-300'
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}
