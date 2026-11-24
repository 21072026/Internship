import { getDictionary } from '@/i18n/dictionaries';
import { locales } from '@/i18n/config';
import type { HandoffAction } from '@/lib/leadHandoffRule';

/**
 * Every locale's labels for the hand-off's quick picks — what a composed
 * follow-up note may start with, in whichever language its writer used
 * (handoffActionFromNote, #3821/#3900).
 */
export function handoffActionLabelsByLocale(): Readonly<Record<HandoffAction, string>>[] {
  return locales.map((l) => getDictionary(l).leadHandoff.actions);
}
