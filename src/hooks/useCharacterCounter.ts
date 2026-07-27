import { useMemo } from 'react';

export function useCharacterCounter(value: string, maxLength: number) {
  const count = value.length;
  const remaining = maxLength - count;
  const percentage = (count / maxLength) * 100;

  const state = useMemo(() => {
    if (percentage >= 100) return 'error';
    if (percentage >= 80) return 'warning';
    return 'normal';
  }, [percentage]);

  return {
    count,
    remaining,
    maxLength,
    percentage,
    state,
    isOverLimit: count > maxLength,
    display: `${count}/${maxLength}`,
  };
}
