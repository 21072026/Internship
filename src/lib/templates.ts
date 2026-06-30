// Document templates v2 — a localized, code-owned catalog (EN/TR/DE).
//
// Templates used to live as single-language markdown blobs in the DB and were
// only downloadable. Here they are structured per-locale so the UI can switch
// language, preview the rendered content, and export to PDF / TXT / Markdown
// without any server-side binary generation (PDF is produced via the browser's
// print pipeline from styled HTML — Docker-safe, no headless Chromium).

export type TemplateLocale = 'en' | 'tr' | 'de';

export interface DocTemplate {
  id: string;
  /** lucide-react icon name, resolved in the UI. */
  icon: string;
  title: Record<TemplateLocale, string>;
  /** One-line description shown in the list. */
  summary: Record<TemplateLocale, string>;
  /** Markdown body (constrained subset: #/##/### headings, **bold**, - bullets, [ ] checkboxes, paragraphs). */
  body: Record<TemplateLocale, string>;
}

const CV: DocTemplate = {
  id: 'cv',
  icon: 'FileText',
  title: { en: 'CV (sample)', tr: 'Özgeçmiş (örnek)', de: 'Lebenslauf (Muster)' },
  summary: {
    en: 'A clean, recruiter-friendly CV structure.',
    tr: 'Sade, işe alımcı dostu bir özgeçmiş yapısı.',
    de: 'Eine klare, recruiter-freundliche Lebenslauf-Struktur.',
  },
  body: {
    en: `# Curriculum Vitae

## Personal details
- Name: [First and last name]
- Address: [Street, ZIP City]
- Phone: [Number]
- E-mail: [E-mail]
- LinkedIn / GitHub: [Links]

## Profile
[2–3 sentences: who you are, your focus, your goal.]

## Experience / Internships
- **[Position]**, [Company] — [City] ([Mon/Year – Mon/Year])
  - [Achievement or task with a measurable result]
  - [Achievement or task]

## Education
- **[Degree]**, [University] — [City] ([Year – Year])
  - Focus areas: [Subjects]

## Skills
- Technical: [e.g. React, Python, SQL]
- Languages: [English C1, German B2, …]

## Projects
- **[Project name]** — [short description + link]
`,
    tr: `# Özgeçmiş

## Kişisel bilgiler
- Ad Soyad: [Ad ve soyad]
- Adres: [Sokak, Posta Kodu, Şehir]
- Telefon: [Numara]
- E-posta: [E-posta]
- LinkedIn / GitHub: [Bağlantılar]

## Kısa profil
[2–3 cümle: kim olduğun, uzmanlık alanın, hedefin.]

## Deneyim / Stajlar
- **[Pozisyon]**, [Şirket] — [Şehir] ([Ay/Yıl – Ay/Yıl])
  - [Ölçülebilir sonucu olan başarı veya görev]
  - [Başarı veya görev]

## Eğitim
- **[Derece]**, [Üniversite] — [Şehir] ([Yıl – Yıl])
  - Odak alanları: [Dersler]

## Yetkinlikler
- Teknik: [örn. React, Python, SQL]
- Diller: [İngilizce C1, Almanca B2, …]

## Projeler
- **[Proje adı]** — [kısa açıklama + bağlantı]
`,
    de: `# Lebenslauf

## Persönliche Daten
- Name: [Vor- und Nachname]
- Adresse: [Straße, PLZ Ort]
- Telefon: [Nummer]
- E-Mail: [E-Mail]
- LinkedIn / GitHub: [Links]

## Kurzprofil
[2–3 Sätze: wer du bist, dein Schwerpunkt, dein Ziel.]

## Berufserfahrung / Praktika
- **[Position]**, [Firma] — [Ort] ([Monat/Jahr – Monat/Jahr])
  - [Erfolg/Aufgabe mit messbarem Ergebnis]
  - [Erfolg/Aufgabe]

## Ausbildung
- **[Abschluss]**, [Universität] — [Ort] ([Jahr – Jahr])
  - Schwerpunkte: [Fächer]

## Kenntnisse
- Technisch: [z. B. React, Python, SQL]
- Sprachen: [Deutsch C1, Englisch B2, …]

## Projekte
- **[Projektname]** — [kurze Beschreibung + Link]
`,
  },
};

const COVER_LETTER: DocTemplate = {
  id: 'cover-letter',
  icon: 'Mail',
  title: { en: 'Cover letter (sample)', tr: 'Ön yazı (örnek)', de: 'Anschreiben (Muster)' },
  summary: {
    en: 'A persuasive application cover letter.',
    tr: 'İkna edici bir başvuru ön yazısı.',
    de: 'Ein überzeugendes Bewerbungsanschreiben.',
  },
  body: {
    en: `[Your name]
[Address] · [Phone] · [E-mail]

[Company]
[Contact person]
[Address]

[City, date]

**Application for [Position]**

Dear [Mr./Ms. Last name],

I read your posting for [Position] with great interest.
[1–2 sentences: why this company / this role excites you.]

During [studies/internship/project] I gained [relevant skill/achievement].
[A concrete example with a result.] This is the value I would bring to your team.

I would welcome the opportunity to discuss my application in person.

Kind regards,
[Your name]
`,
    tr: `[Adınız]
[Adres] · [Telefon] · [E-posta]

[Şirket]
[İlgili kişi]
[Adres]

[Şehir, tarih]

**[Pozisyon] başvurusu**

Sayın [Bay/Bayan Soyad],

[Pozisyon] ilanınızı büyük bir ilgiyle okudum.
[1–2 cümle: bu şirket / bu rol sizi neden heyecanlandırıyor.]

[Eğitim/staj/proje] sırasında [ilgili beceri/başarı] kazandım.
[Sonucu olan somut bir örnek.] Bu değeri ekibinize katacağıma inanıyorum.

Başvurumu yüz yüze görüşme fırsatından memnuniyet duyarım.

Saygılarımla,
[Adınız]
`,
    de: `[Dein Name]
[Adresse] · [Telefon] · [E-Mail]

[Firma]
[Ansprechpartner]
[Adresse]

[Ort, Datum]

**Bewerbung als [Position]**

Sehr geehrte/r [Frau/Herr Nachname],

mit großem Interesse habe ich Ihre Ausschreibung für [Position] gelesen.
[1–2 Sätze: warum diese Firma / diese Rolle dich begeistert.]

Während [Studium/Praktikum/Projekt] habe ich [relevante Fähigkeit/Erfolg]
gesammelt. [Konkretes Beispiel mit Ergebnis.] Dadurch bringe ich [Mehrwert]
für Ihr Team mit.

Über die Möglichkeit eines persönlichen Gesprächs freue ich mich sehr.

Mit freundlichen Grüßen
[Dein Name]
`,
  },
};

const REFERENCE_REQUEST: DocTemplate = {
  id: 'reference-request',
  icon: 'Mail',
  title: { en: 'Reference request (e-mail)', tr: 'Referans talebi (e-posta)', de: 'Referenzanfrage (E-Mail)' },
  summary: {
    en: 'Politely ask someone to be your reference.',
    tr: 'Birinden kibarca referansınız olmasını isteyin.',
    de: 'Bitte jemanden höflich, deine Referenz zu sein.',
  },
  body: {
    en: `Subject: Reference request for [position / program]

Hi [Name],

I hope you're well. I'm applying for [position/program] at [company] and
would be grateful if you'd act as a reference.

A few details to help you:
- Role/relationship: [how we worked together]
- Timeframe: [dates]
- What to highlight: [skills/achievements relevant to the role]
- Deadline: [date]

Thank you so much — happy to share my CV and the job description.

Best regards,
[Your name]
`,
    tr: `Konu: [pozisyon / program] için referans talebi

Merhaba [İsim],

Umarım iyisinizdir. [Şirket] firmasındaki [pozisyon/program] için başvuruyorum
ve referansım olmanız beni çok mutlu eder.

Yardımcı olması için birkaç ayrıntı:
- Rol/ilişki: [birlikte nasıl çalıştık]
- Zaman aralığı: [tarihler]
- Öne çıkarılacaklar: [role uygun beceriler/başarılar]
- Son tarih: [tarih]

Çok teşekkürler — özgeçmişimi ve iş tanımını memnuniyetle paylaşırım.

Saygılarımla,
[Adınız]
`,
    de: `Betreff: Referenzanfrage für [Position / Programm]

Hallo [Name],

ich hoffe, es geht dir gut. Ich bewerbe mich für [Position/Programm] bei
[Firma] und würde mich sehr freuen, wenn du als Referenz fungieren würdest.

Ein paar Details zur Hilfe:
- Rolle/Beziehung: [wie wir zusammengearbeitet haben]
- Zeitraum: [Daten]
- Was hervorzuheben ist: [relevante Fähigkeiten/Erfolge]
- Frist: [Datum]

Vielen Dank — ich teile gern meinen Lebenslauf und die Stellenbeschreibung.

Viele Grüße
[Dein Name]
`,
  },
};

const INTERNSHIP_REPORT: DocTemplate = {
  id: 'internship-report',
  icon: 'ClipboardList',
  title: { en: 'Internship report (outline)', tr: 'Staj raporu (taslak)', de: 'Praktikumsbericht (Gliederung)' },
  summary: {
    en: 'A structure for your internship report.',
    tr: 'Staj raporunuz için bir yapı.',
    de: 'Eine Struktur für deinen Praktikumsbericht.',
  },
  body: {
    en: `# Internship report — outline

1. **Cover page** — name, company, period, supervisor
2. **Introduction** — why this internship? expectations.
3. **The company** — industry, size, department.
4. **My tasks** — weekly overview, concrete projects.
5. **Skills learned** — technical & personal.
6. **Challenges & solutions**
7. **Conclusion** — were expectations met? next steps.
8. **Appendix** — evidence, screenshots, certificate.
`,
    tr: `# Staj raporu — taslak

1. **Kapak sayfası** — ad, şirket, dönem, danışman
2. **Giriş** — neden bu staj? beklentiler.
3. **Şirket** — sektör, büyüklük, departman.
4. **Görevlerim** — haftalık genel bakış, somut projeler.
5. **Kazanılan beceriler** — teknik ve kişisel.
6. **Zorluklar ve çözümler**
7. **Sonuç** — beklentiler karşılandı mı? sonraki adımlar.
8. **Ek** — belgeler, ekran görüntüleri, staj belgesi.
`,
    de: `# Praktikumsbericht — Gliederung

1. **Deckblatt** — Name, Firma, Zeitraum, Betreuer
2. **Einleitung** — Warum dieses Praktikum? Erwartungen.
3. **Das Unternehmen** — Branche, Größe, Abteilung.
4. **Meine Aufgaben** — Wochenüberblick, konkrete Projekte.
5. **Gelernte Fähigkeiten** — fachlich & persönlich.
6. **Herausforderungen & Lösungen**
7. **Fazit** — Wurden die Erwartungen erfüllt? Nächste Schritte.
8. **Anhang** — Belege, Screenshots, Bescheinigung.
`,
  },
};

const INTERVIEW_PREP: DocTemplate = {
  id: 'interview-prep',
  icon: 'CheckSquare',
  title: { en: 'Interview prep checklist', tr: 'Mülakat hazırlık listesi', de: 'Interview-Vorbereitungs-Checkliste' },
  summary: {
    en: 'Be ready before, during and after an interview.',
    tr: 'Mülakat öncesi, sırası ve sonrası için hazır olun.',
    de: 'Sei vor, während und nach dem Interview bereit.',
  },
  body: {
    en: `# Interview prep checklist

## Before
- [ ] Research the company (product, mission, recent news)
- [ ] Re-read the job description; map your experience to each requirement
- [ ] Prepare 3–5 STAR stories (Situation, Task, Action, Result)
- [ ] Prepare questions to ask them
- [ ] Test your camera/mic and link (for remote)

## Common questions
- [ ] Tell me about yourself (2-minute pitch)
- [ ] Why this role / company?
- [ ] A challenge you overcame
- [ ] A conflict and how you handled it
- [ ] Where do you see yourself in 2–3 years?

## After
- [ ] Send a short thank-you note
- [ ] Note what went well / to improve
`,
    tr: `# Mülakat hazırlık listesi

## Öncesi
- [ ] Şirketi araştır (ürün, misyon, güncel haberler)
- [ ] İş tanımını tekrar oku; deneyimini her gereksinimle eşleştir
- [ ] 3–5 STAR hikâyesi hazırla (Durum, Görev, Eylem, Sonuç)
- [ ] Onlara soracağın sorular hazırla
- [ ] Kamera/mikrofon ve bağlantını test et (uzaktan için)

## Sık sorulan sorular
- [ ] Kendinizden bahseder misiniz (2 dakikalık tanıtım)
- [ ] Neden bu rol / şirket?
- [ ] Üstesinden geldiğin bir zorluk
- [ ] Bir anlaşmazlık ve nasıl yönettiğin
- [ ] Kendini 2–3 yıl sonra nerede görüyorsun?

## Sonrası
- [ ] Kısa bir teşekkür notu gönder
- [ ] Neyin iyi gittiğini / nelerin geliştirileceğini not et
`,
    de: `# Interview-Vorbereitungs-Checkliste

## Davor
- [ ] Unternehmen recherchieren (Produkt, Mission, aktuelle News)
- [ ] Stellenbeschreibung erneut lesen; Erfahrung jeder Anforderung zuordnen
- [ ] 3–5 STAR-Geschichten vorbereiten (Situation, Task, Action, Result)
- [ ] Eigene Fragen vorbereiten
- [ ] Kamera/Mikro und Link testen (für Remote)

## Häufige Fragen
- [ ] Erzählen Sie etwas über sich (2-Minuten-Pitch)
- [ ] Warum diese Rolle / dieses Unternehmen?
- [ ] Eine gemeisterte Herausforderung
- [ ] Ein Konflikt und wie du ihn gelöst hast
- [ ] Wo siehst du dich in 2–3 Jahren?

## Danach
- [ ] Eine kurze Dankesnachricht senden
- [ ] Notieren, was gut lief / verbessert werden kann
`,
  },
};

export const TEMPLATES: DocTemplate[] = [
  CV,
  COVER_LETTER,
  REFERENCE_REQUEST,
  INTERNSHIP_REPORT,
  INTERVIEW_PREP,
];

export function getTemplate(id: string): DocTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function isTemplateLocale(v: string): v is TemplateLocale {
  return v === 'en' || v === 'tr' || v === 'de';
}
