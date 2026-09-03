'use client';

import React from 'react';
import { useCharacterCounter } from '@/hooks/useCharacterCounter';
import { useAnnounce } from '@/components/ui/LiveRegion';
import { useT } from '@/i18n/client';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  maxLength?: number;
  showCounter?: boolean;
  /**
   * Classes for the positioning wrapper, not the textarea. The counter is
   * absolutely positioned, so the textarea has to sit in a `relative` div —
   * which means layout classes the PARENT cares about (`flex-1` in a flex row,
   * for instance) belong here, otherwise they land on the inner textarea and
   * silently do nothing.
   */
  wrapperClassName?: string;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', wrapperClassName = '', maxLength = 65535, showCounter = false, value, defaultValue, onChange, ...props }, ref) => {
    // Controlled vs uncontrolled: react-hook-form's `register()` supplies
    // name/onChange/onBlur/ref but NO `value`. Defaulting `value` to '' and
    // hard-binding it made such a field a controlled input pinned to the empty
    // string — impossible to type into (this is what broke CompanyForm's
    // description box). So pass `value` through only when the caller actually
    // provides one, and mirror the text into state otherwise so the counter
    // still tracks an uncontrolled field.
    const isControlled = value !== undefined;
    const [uncontrolledText, setUncontrolledText] = React.useState(
      defaultValue === undefined ? '' : String(defaultValue)
    );

    const text = isControlled ? String(value) : uncontrolledText;
    const counter = useCharacterCounter(text, maxLength);
    const shouldShowCounter = showCounter && maxLength < 65535;

    // WCAG 4.1.3: the counter is a visual-only cue — it changes colour at 80%
    // and at the limit, and a screen-reader user is told nothing. Announce the
    // two THRESHOLD CROSSINGS only: `state` changes at most twice per field, so
    // this never speaks per keystroke (which would make the field unusable).
    const t = useT();
    const announce = useAnnounce();
    const previousState = React.useRef(counter.state);
    React.useEffect(() => {
      const previous = previousState.current;
      previousState.current = counter.state;
      if (!shouldShowCounter || previous === counter.state) return;
      if (counter.state === 'error') {
        announce(t.a11y.characterLimitReached, 'assertive');
      } else if (counter.state === 'warning') {
        announce(t.a11y.charactersRemaining.replace('{count}', String(Math.max(0, counter.remaining))));
      }
    }, [counter.state, counter.remaining, shouldShowCounter, announce, t]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (!isControlled) setUncontrolledText(e.target.value);
      onChange?.(e);
    };

    const counterColor =
      counter.state === 'error' ? 'text-red-600 dark:text-red-400' : counter.state === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400';

    return (
      <div className={`relative ${wrapperClassName}`}>
        <textarea
          ref={ref}
          {...(isControlled ? { value } : {})}
          {...(defaultValue === undefined ? {} : { defaultValue })}
          onChange={handleChange}
          maxLength={maxLength}
          // pb-7 when the counter is shown: the counter is absolutely positioned
          // bottom-right, so without extra bottom padding the last line of text
          // runs underneath it — worst exactly when the field is nearly full,
          // which is when the counter matters most.
          className={`w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-blue-400 dark:focus:ring-blue-400 ${
            shouldShowCounter ? 'pb-7' : ''
          } ${counter?.isOverLimit ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''} ${className}`}
          {...props}
        />
        {shouldShowCounter && (
          // pointer-events-none: the span overlaps the native resize grabber in
          // the bottom-right corner, and without it the span swallows the drag
          // so the textarea can no longer be resized with the mouse.
          <span
            data-testid="textarea-counter"
            data-counter-state={counter.state}
            className={`pointer-events-none select-none absolute bottom-2 right-3 text-xs font-medium ${counterColor}`}
          >
            {counter.display}
          </span>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

export { Textarea };
