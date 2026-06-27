import type { Locale } from './config';

// UI string dictionary. Add keys here and reference them via getDictionary()
// (server components) or the useT() hook (client components).
const en = {
  nav: {
    dashboard: 'Dashboard',
    companies: 'Companies',
    candidates: 'Candidates',
    mentors: 'Mentors',
    mentorships: 'Mentorships',
    invite: 'Send Invitation',
    myMentees: 'My Mentees',
    board: 'Board',
    interactionLogs: 'Interaction Logs',
    myProfile: 'My Profile',
    signOut: 'Sign Out',
  },
  panel: {
    admin: 'Admin Panel',
    mentor: 'Mentor Portal',
    mentee: 'Mentee Portal',
  },
  lang: { en: 'English', tr: 'Türkçe', label: 'Language' },
};

type Dict = typeof en;

const tr: Dict = {
  nav: {
    dashboard: 'Panel',
    companies: 'Şirketler',
    candidates: 'Adaylar',
    mentors: 'Mentorlar',
    mentorships: 'Mentorluklar',
    invite: 'Davet Gönder',
    myMentees: 'Mentee’lerim',
    board: 'Pano',
    interactionLogs: 'Etkileşim Kayıtları',
    myProfile: 'Profilim',
    signOut: 'Çıkış Yap',
  },
  panel: {
    admin: 'Yönetim Paneli',
    mentor: 'Mentor Portalı',
    mentee: 'Mentee Portalı',
  },
  lang: { en: 'English', tr: 'Türkçe', label: 'Dil' },
};

export const dictionaries: Record<Locale, Dict> = { en, tr };
export type Dictionary = Dict;

export function getDictionary(locale: Locale): Dict {
  return dictionaries[locale] ?? en;
}
