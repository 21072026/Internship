import { SelectHTMLAttributes, forwardRef } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(inputs));
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
  // `group` puts the option under an <optgroup> with that label (#1296 — the
  // referrer picker lists registered people and Source rows side by side).
  // Order is preserved exactly as given; see chunkOptions.
  options: Opt[];
  placeholder?: string;
}

type Opt = { value: string; label: string; group?: string };

// Chunk the options *in their given order* so grouping never reorders anything:
// consecutive options sharing a `group` become one <optgroup>, ungrouped options
// stay where the caller put them (the referrer picker's "+ add a new source"
// option has to come last, after the groups).
function chunkOptions(options: Opt[]): ({ group: null; option: Opt } | { group: string; options: Opt[] })[] {
  const chunks: ({ group: null; option: Opt } | { group: string; options: Opt[] })[] = [];
  for (const opt of options) {
    if (!opt.group) {
      chunks.push({ group: null, option: opt });
      continue;
    }
    const last = chunks[chunks.length - 1];
    if (last && last.group === opt.group) last.options.push(opt);
    else chunks.push({ group: opt.group, options: [opt] });
  }
  return chunks;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, hint, id, options, placeholder, ...props }, ref) => {
    const selectId = id || label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={selectId}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
          >
            {label}
            {props.required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={cn(
            'block min-h-11 w-full rounded-lg border px-3.5 py-2.5 text-sm text-gray-900 dark:text-gray-100',
            'focus:outline-none focus:ring-2 focus:ring-offset-0',
            'transition-colors duration-150 bg-white dark:bg-gray-800',
            error
              ? 'border-red-300 focus:border-red-400 focus:ring-red-200'
              : 'border-gray-300 dark:border-gray-700 focus:border-blue-400 focus:ring-blue-100',
            'disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed',
            className
          )}
          {...props}
        >
          {/* A placeholder renders a disabled empty option; do not also pass an empty-value option. */}
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {chunkOptions(options).map((chunk, i) =>
            chunk.group === null ? (
              <option key={chunk.option.value} value={chunk.option.value}>
                {chunk.option.label}
              </option>
            ) : (
              <optgroup key={`${chunk.group}-${i}`} label={chunk.group}>
                {chunk.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </optgroup>
            )
          )}
        </select>
        {hint && !error && <p className="mt-1.5 text-xs text-gray-500">{hint}</p>}
        {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
      </div>
    );
  }
);

Select.displayName = 'Select';
