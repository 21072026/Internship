import React from 'react';
import { useCharacterCounter } from '@/hooks/useCharacterCounter';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  maxLength?: number;
  showCounter?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', maxLength = 65535, showCounter = false, value = '', onChange, ...props }, ref) => {
    const counter = useCharacterCounter(String(value), maxLength);
    const shouldShowCounter = showCounter && maxLength < 65535;

    const counterColor =
      counter.state === 'error' ? 'text-red-600 dark:text-red-400' : counter.state === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400';

    return (
      <div className="relative">
        <textarea
          ref={ref}
          value={value}
          onChange={onChange}
          maxLength={maxLength}
          className={`w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-blue-400 dark:focus:ring-blue-400 ${
            counter?.isOverLimit ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''
          } ${className}`}
          {...props}
        />
        {shouldShowCounter && (
          <span className={`absolute bottom-2 right-3 text-xs font-medium ${counterColor}`}>{counter.display}</span>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

export { Textarea };
