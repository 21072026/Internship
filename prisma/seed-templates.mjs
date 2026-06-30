// Idempotent seed of starter document templates (admin-managed, downloadable by
// everyone). Safe to run on every deploy: a template is only created if no
// template with the same title exists yet. Runs against DATABASE_URL.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TEMPLATES = [
  {
    title: 'Lebenslauf (Muster CV)',
    filename: 'lebenslauf-muster.md',
    body: `# Lebenslauf

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
  {
    title: 'Anschreiben (Muster / Cover letter)',
    filename: 'anschreiben-muster.md',
    body: `[Dein Name]
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
  {
    title: 'Reference request (e-mail)',
    filename: 'reference-request.md',
    body: `Subject: Reference request for [position / program]

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
  },
  {
    title: 'Praktikumsbericht (Internship report outline)',
    filename: 'praktikumsbericht-outline.md',
    body: `# Praktikumsbericht — Gliederung

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
  {
    title: 'Interview prep checklist',
    filename: 'interview-prep-checklist.md',
    body: `# Interview prep checklist

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
  },
];

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
  if (!admin) {
    console.log('[seed-templates] no admin user yet; skipping.');
    return;
  }
  let created = 0;
  for (const tpl of TEMPLATES) {
    const exists = await prisma.document.findFirst({ where: { isTemplate: true, title: tpl.title }, select: { id: true } });
    if (exists) continue;
    await prisma.document.create({
      data: {
        ownerId: null,
        uploaderId: admin.id,
        type: 'OTHER',
        title: tpl.title,
        filename: tpl.filename,
        contentType: 'text/markdown; charset=utf-8',
        size: Buffer.byteLength(tpl.body, 'utf8'),
        isTemplate: true,
        data: Buffer.from(tpl.body, 'utf8'),
      },
    });
    created++;
  }
  console.log(`[seed-templates] created ${created} of ${TEMPLATES.length} templates.`);
}

main()
  .catch((e) => { console.error('[seed-templates] error:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
