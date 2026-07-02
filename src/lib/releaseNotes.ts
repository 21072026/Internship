// User-facing release notes (EN/TR/DE) — friendly, feature-level summaries for
// end users. Distinct from CHANGELOG.md, which is the developer-facing,
// commit-level record. Add a new entry here (newest first) alongside each
// notable release; bump APP_VERSION in package.json to match.

import type { Locale } from '@/i18n/config';

export interface ReleaseNote {
  version: string;
  date: string; // ISO date (release day)
  highlights: Record<Locale, string[]>;
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '0.2.0-beta',
    date: '2026-07-01',
    highlights: {
      en: [
        'Dark mode — follows your system by default, or switch it yourself from any sidebar. Your choice is remembered on your account.',
        'CV tools — upload your CV and get one-click suggestions for your profile fields and skills, parsed locally on our server (nothing sent anywhere). An optional AI-assisted mode can fill in more fields once you turn it on in Account → Privacy.',
        'Document templates — CV, cover letter, interview-prep checklist and more, now with an in-app preview and export to PDF, Word-friendly text, or Markdown, in your language.',
        'Public profile upgrades — visitors can switch language and theme, get a link back to InternshipCRM, and send you a message directly (spam-protected).',
        'Skill ratings — self-assess your skills with a simple 1–5 star picker instead of a dropdown.',
        'A number of dark-mode and navigation polish fixes across the app.',
      ],
      tr: [
        'Karanlık mod — varsayılan olarak işletim sisteminizi takip eder, dilerseniz herhangi bir kenar çubuğundan değiştirebilirsiniz. Tercihiniz hesabınızda hatırlanır.',
        'CV araçları — CV\'nizi yükleyin, profil alanlarınız ve becerileriniz için tek tıkla öneriler alın; işlem sunucumuzda yerel olarak yapılır (hiçbir yere gönderilmez). Hesap → Gizlilik\'ten açtığınızda isteğe bağlı AI destekli mod daha fazla alanı doldurabilir.',
        'Doküman şablonları — CV, ön yazı, mülakat hazırlık listesi ve daha fazlası; artık uygulama içi önizleme ve dilinizde PDF, Word-uyumlu metin veya Markdown olarak dışa aktarma ile.',
        'Herkese açık profil geliştirmeleri — ziyaretçiler dil ve temayı değiştirebilir, InternshipCRM\'e geri dönen bir bağlantı görebilir ve size doğrudan mesaj gönderebilir (spam korumalı).',
        'Yetenek değerlendirmesi — becerilerinizi açılır menü yerine basit bir 1–5 yıldız seçiciyle değerlendirin.',
        'Uygulama genelinde çok sayıda karanlık mod ve gezinme iyileştirmesi.',
      ],
      de: [
        'Dunkelmodus — folgt standardmäßig deinem System, oder wechsle ihn selbst über jede Seitenleiste. Deine Wahl wird für dein Konto gespeichert.',
        'Lebenslauf-Tools — lade deinen Lebenslauf hoch und erhalte mit einem Klick Vorschläge für deine Profilfelder und Fähigkeiten, lokal auf unserem Server verarbeitet (nichts wird irgendwohin gesendet). Ein optionaler KI-gestützter Modus kann weitere Felder ausfüllen, sobald du ihn unter Konto → Datenschutz aktivierst.',
        'Dokumentvorlagen — Lebenslauf, Anschreiben, Interview-Checkliste und mehr, jetzt mit Vorschau in der App und Export als PDF, Word-freundlicher Text oder Markdown, in deiner Sprache.',
        'Verbessertes öffentliches Profil — Besucher können Sprache und Theme wechseln, finden einen Link zurück zu InternshipCRM und können dir direkt eine Nachricht senden (spamgeschützt).',
        'Fähigkeitsbewertung — bewerte deine Fähigkeiten mit einer einfachen 1–5-Sterne-Auswahl statt eines Dropdowns.',
        'Zahlreiche Verbesserungen am Dunkelmodus und an der Navigation in der gesamten App.',
      ],
    },
  },
  {
    version: '0.1.0',
    date: '2026-01-01',
    highlights: {
      en: [
        'The original platform: mentor–mentee pipeline tracking, role-based dashboards for admins, mentors, mentees and companies, interaction logging, analytics, document uploads, two-factor authentication, and multi-language support (EN/TR/DE).',
        'This is a retroactive summary — detailed release notes start with 0.2.0-beta.',
      ],
      tr: [
        'Orijinal platform: mentor–mentee süreç takibi, admin/mentör/mentee/şirket için rol bazlı panolar, etkileşim kaydı, analitik, doküman yükleme, iki faktörlü kimlik doğrulama ve çok dilli destek (EN/TR/DE).',
        'Bu geriye dönük bir özettir — detaylı sürüm notları 0.2.0-beta ile başlar.',
      ],
      de: [
        'Die ursprüngliche Plattform: Mentor-Mentee-Pipeline-Tracking, rollenbasierte Dashboards für Admins, Mentoren, Mentees und Unternehmen, Interaktionsprotokolle, Analysen, Dokument-Uploads, Zwei-Faktor-Authentifizierung und mehrsprachige Unterstützung (EN/TR/DE).',
        'Dies ist eine rückwirkende Zusammenfassung — detaillierte Versionshinweise beginnen mit 0.2.0-beta.',
      ],
    },
  },
];

export const LATEST_RELEASE_VERSION = RELEASE_NOTES[0]?.version ?? '0.0.0';
