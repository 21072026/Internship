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
    version: '0.4.0-beta',
    date: '2026-07-10',
    highlights: {
      en: [
        'Company Premium — companies can now search a privacy-safe talent pool of mentees who opted in, see a "verified" candidate card with mentor evaluations and project work, get alerts when a candidate matches an open position, and preview newly-hireable candidates first. Mentor and mentee features stay free.',
        'Messaging is easier to reach — a new inbox icon in the header and a single Messages page for all your conversations.',
        'Daily activity report — mentors and admins can get a daily summary of mentee activity (logins, time on site, pages visited, completed to-dos).',
        'Mentor attention queue — mentees with no open goal are now flagged, and you get an in-app heads-up when a mentee goes quiet.',
        'Tidier admin — deactivated users move to an "Archived" tab instead of cluttering the list; assign a mentor to a candidate right from the Candidates screen.',
        'Personalization — pick your own accent color for the app.',
        'Fixes — mobile users can now reach Sign out from the menu; editing a company with empty optional fields no longer errors; emails land in the inbox more reliably.',
      ],
      tr: [
        'Şirket Premium — şirketler artık rıza vermiş mentee’lerden oluşan gizlilik-güvenli bir yetenek havuzunda arama yapabilir, mentör değerlendirmeleri ve proje çalışmasıyla "doğrulanmış" aday kartını görebilir, açık pozisyona uyan aday çıkınca bildirim alabilir ve yeni işe alınabilir adayları önce görebilir. Mentör ve mentee özellikleri ücretsiz kalır.',
        'Mesajlaşmaya erişim kolaylaştı — başlıkta yeni bir gelen kutusu ikonu ve tüm sohbetleriniz için tek bir Mesajlar sayfası.',
        'Günlük aktivite raporu — mentör ve adminler mentee aktivitesinin (giriş, sitede geçen süre, gezilen sayfalar, tamamlanan görevler) günlük özetini alabilir.',
        'Mentor dikkat kuyruğu — açık hedefi olmayan mentee’ler artık işaretleniyor ve bir mentee sessizleştiğinde uygulama içi uyarı alıyorsunuz.',
        'Daha derli admin — pasifleştirilen kullanıcılar listeyi doldurmak yerine "Arşiv" sekmesine taşınıyor; adayı doğrudan Adaylar ekranından bir mentöre atayabilirsiniz.',
        'Kişiselleştirme — uygulama için kendi vurgu renginizi seçin.',
        'Düzeltmeler — mobil kullanıcılar artık menüden Çıkış’a ulaşabiliyor; opsiyonel alanları boş bir şirketi düzenlemek artık hata vermiyor; e-postalar gelen kutusuna daha güvenilir ulaşıyor.',
      ],
      de: [
        'Unternehmens-Premium — Unternehmen können jetzt in einem datenschutzfreundlichen Talent-Pool von Mentees suchen, die zugestimmt haben, eine „verifizierte" Kandidatenkarte mit Mentor-Bewertungen und Projektarbeit sehen, Benachrichtigungen bei passenden Kandidaten erhalten und neu vermittelbare Kandidaten zuerst sehen. Mentor- und Mentee-Funktionen bleiben kostenlos.',
        'Nachrichten sind leichter erreichbar — ein neues Posteingang-Symbol in der Kopfzeile und eine einzige Nachrichten-Seite für alle Unterhaltungen.',
        'Täglicher Aktivitätsbericht — Mentoren und Admins erhalten eine tägliche Zusammenfassung der Mentee-Aktivität (Logins, Verweildauer, besuchte Seiten, erledigte To-dos).',
        'Mentor-Aufmerksamkeitsliste — Mentees ohne offenes Ziel werden jetzt markiert, und du bekommst einen In-App-Hinweis, wenn ein Mentee still wird.',
        'Aufgeräumtere Verwaltung — deaktivierte Nutzer wandern in einen „Archiviert"-Tab, statt die Liste zu überladen; weise einem Kandidaten direkt aus der Kandidaten-Ansicht einen Mentor zu.',
        'Personalisierung — wähle deine eigene Akzentfarbe für die App.',
        'Korrekturen — Mobile Nutzer erreichen jetzt „Abmelden" im Menü; das Bearbeiten eines Unternehmens mit leeren optionalen Feldern schlägt nicht mehr fehl; E-Mails landen zuverlässiger im Posteingang.',
      ],
    },
  },
  {
    version: '0.3.0-beta',
    date: '2026-07-03',
    highlights: {
      en: [
        'Meetings & calendar — schedule a meeting, mentees RSVP with one click, and everything shows on the calendar with reminder emails.',
        'Smarter mentor matching — suggestions now rank by real skill overlap, and mentors can set their expertise and how many mentees they can take on.',
        'Analytics you can trust — "time in stage" is now computed from real pipeline history, plus a date-range filter (last 30/90 days, 6/12 months).',
        'Cleaner pipeline board — the 13 stages are grouped into collapsible phases (pre-internship / internship / outcome), with overdue flags and a workload hint.',
        'Account security — your organization can require two-factor authentication, sessions time out automatically, and you can now "sign out of all devices".',
        'Privacy — cookie consent is now by category (necessary / analytics / …), and the whole app is fully translated in English, Turkish and German.',
        'Everyday polish — invitation status with timestamps, confirmation toasts on changes, editable notes, a dedicated My Notes page, message attachments, and an adjustable font size.',
      ],
      tr: [
        'Toplantılar & takvim — toplantı planla, mentee’ler tek tıkla katılım (RSVP) versin; her şey hatırlatma e-postalarıyla takvimde görünsün.',
        'Daha akıllı mentor eşleştirme — öneriler artık gerçek yetenek örtüşmesine göre sıralanıyor; mentörler uzmanlıklarını ve kaç mentee alabileceklerini belirleyebiliyor.',
        'Güvenilir analitik — "aşamada geçen süre" artık gerçek süreç geçmişinden hesaplanıyor; ayrıca tarih aralığı filtresi (son 30/90 gün, 6/12 ay).',
        'Daha derli toplu pano — 13 aşama katlanabilir fazlara gruplandı (staj öncesi / staj / sonuç); gecikme işaretleri ve iş yükü uyarısıyla.',
        'Hesap güvenliği — kuruluşunuz iki adımlı doğrulamayı zorunlu kılabilir, oturumlar otomatik zaman aşımına uğrar ve artık "tüm cihazlardan çıkış" yapabilirsiniz.',
        'Gizlilik — çerez rızası artık kategori bazlı (gerekli / analitik / …) ve tüm uygulama İngilizce, Türkçe ve Almanca olarak eksiksiz çevrildi.',
        'Günlük iyileştirmeler — zaman damgalı davet durumu, değişikliklerde onay bildirimleri, düzenlenebilir notlar, ayrı bir Notlarım sayfası, mesaj ekleri ve ayarlanabilir yazı boyutu.',
      ],
      de: [
        'Meetings & Kalender — plane ein Meeting, Mentees sagen mit einem Klick zu (RSVP), und alles erscheint im Kalender samt Erinnerungs-E-Mails.',
        'Intelligenteres Mentoren-Matching — Vorschläge werden nach echter Fähigkeiten-Überschneidung sortiert, und Mentoren können ihre Expertise und Kapazität festlegen.',
        'Verlässliche Analysen — die „Zeit in Phase" wird jetzt aus dem echten Pipeline-Verlauf berechnet, plus ein Zeitraumfilter (letzte 30/90 Tage, 6/12 Monate).',
        'Übersichtlicheres Board — die 13 Phasen sind in einklappbare Abschnitte gruppiert (vor dem Praktikum / Praktikum / Ergebnis), mit Überfällig-Markierungen und Auslastungshinweis.',
        'Kontosicherheit — deine Organisation kann Zwei-Faktor-Authentifizierung verlangen, Sitzungen laufen automatisch ab, und du kannst dich jetzt „von allen Geräten abmelden".',
        'Datenschutz — die Cookie-Einwilligung erfolgt jetzt kategorienweise (notwendig / Analyse / …), und die gesamte App ist vollständig auf Englisch, Türkisch und Deutsch übersetzt.',
        'Feinschliff im Alltag — Einladungsstatus mit Zeitstempeln, Bestätigungs-Toasts bei Änderungen, bearbeitbare Notizen, eine eigene „Meine Notizen"-Seite, Nachrichtenanhänge und eine anpassbare Schriftgröße.',
      ],
    },
  },
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
