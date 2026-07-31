'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';

type ToastType = 'success' | 'error';
// Optional single action, e.g. "Undo" after a board stage change. A toast that
// carries one stays up longer — there has to be time to reach for it.
export interface ToastAction { label: string; onClick: () => void }
interface ToastItem { id: number; message: string; type: ToastType; action?: ToastAction }

// Minimal, dependency-free toast system. `useToast()` returns a `toast(message,
// type?, action?)` function; toasts auto-dismiss after a few seconds. Rendered in
// a fixed bottom-right stack, dark-mode aware, and announced via role="status".
const ToastContext = createContext<((message: string, type?: ToastType, action?: ToastAction) => void) | null>(null);

const DISMISS_MS = 3200;
const DISMISS_WITH_ACTION_MS = 7000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((message: string, type: ToastType = 'success', action?: ToastAction) => {
    const id = ++idRef.current;
    setItems((prev) => [...prev, { id, message, type, action }]);
    setTimeout(
      () => setItems((prev) => prev.filter((it) => it.id !== id)),
      action ? DISMISS_WITH_ACTION_MS : DISMISS_MS,
    );
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
        {items.map((it) => (
          <div
            key={it.id}
            role="status"
            className={`pointer-events-auto flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm shadow-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 ${
              it.type === 'success' ? 'border-green-200 dark:border-green-900' : 'border-red-200 dark:border-red-900'
            }`}
          >
            {it.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
            ) : (
              <XCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
            )}
            <span>{it.message}</span>
            {it.action && (
              <button
                type="button"
                onClick={() => {
                  setItems((prev) => prev.filter((other) => other.id !== it.id));
                  it.action?.onClick();
                }}
                className="ml-1 rounded px-2 py-0.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-900/40"
              >
                {it.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
