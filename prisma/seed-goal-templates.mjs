// Idempotent seed of the shared project-goal template pool (#51).
//
// A project's template pool is "its own templates + the shared ones"
// (`ProjectTaskTemplate.projectId = null`, see
// src/app/api/projects/[id]/task-templates/route.ts), and until now the shared
// half was empty: every mentor had to type the same starter goals for their
// first mentee before the pool was worth anything. This seeds that shared half
// with a standard internship starter set, so a fresh project can hand a new
// member a sensible list on day one.
//
// Each goal is written in all three languages; the member reads it in theirs
// (src/lib/goalTemplates.ts resolves it when the goal is handed out). `title`
// holds the Turkish wording for the rows seeded before translations existed, so
// it stays the dedupe key here — matching on it keeps this run a no-op on a
// database that already has the set.
//
// Safe to run on every deploy. It does two things and both are idempotent:
// insert the goals that are missing, and fill in translations on rows that
// predate them. MySQL does not enforce the @@unique([projectId, title]) key
// across NULL projectIds, so uniqueness is checked here rather than relying on
// skipDuplicates.
//
// Admins manage this pool at /admin/goal-templates — including deleting entries
// they don't want. A deleted goal is NOT re-created, so this seeder only adds
// what has never been seen: it keys off `title`, and an admin who reworded the
// Turkish text has effectively renamed the row, which then stays as they left it
// (a reword can make this insert the original wording once more — say so rather
// than pretend otherwise).
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// The first-week set from the onboarding wizard's own description — read the
// project, find a bug, find a feature — plus the rest of a typical internship
// arc: getting set up, working in the open, and closing out.
const GOALS = [
  // Getting set up
  {
    tr: 'Projeyi yerelde çalıştır: depoyu klonla, kur ve ayağa kaldır',
    en: 'Get the project running locally: clone, install, start it',
    de: 'Das Projekt lokal zum Laufen bringen: klonen, installieren, starten',
  },
  {
    tr: 'README’i oku; eksik veya yanlış bulduğun bir yeri düzelt',
    en: 'Read the README and fix one thing that is missing or wrong',
    de: 'Die README lesen und eine fehlende oder falsche Stelle korrigieren',
  },
  {
    tr: 'Projenin veri modelini incele ve aklına takılan 3 soruyu yaz',
    en: 'Study the data model and write down the 3 questions it raises',
    de: 'Das Datenmodell ansehen und die 3 Fragen notieren, die offen bleiben',
  },
  {
    tr: 'Bir özelliği baştan sona takip et ve nasıl çalıştığını kısaca anlat',
    en: 'Follow one feature end to end and explain briefly how it works',
    de: 'Ein Feature von Anfang bis Ende verfolgen und kurz erklären, wie es funktioniert',
  },
  // Working on it
  {
    tr: 'Bir hata (bug) bul ve nasıl tekrar edildiğini adım adım yaz',
    en: 'Find a bug and write down the steps to reproduce it',
    de: 'Einen Bug finden und die Schritte zum Reproduzieren aufschreiben',
  },
  {
    tr: 'Bulduğun hatayı düzelt ve pull request aç',
    en: 'Fix the bug you found and open a pull request',
    de: 'Den gefundenen Bug beheben und einen Pull Request öffnen',
  },
  {
    tr: 'Küçük bir özellik öner; neden gerektiğini bir paragrafla anlat',
    en: 'Propose a small feature and explain in a paragraph why it is needed',
    de: 'Ein kleines Feature vorschlagen und in einem Absatz begründen',
  },
  {
    tr: 'Önerdiğin küçük özelliği geliştir ve pull request aç',
    en: 'Build the small feature you proposed and open a pull request',
    de: 'Das vorgeschlagene kleine Feature umsetzen und einen Pull Request öffnen',
  },
  {
    tr: 'Yazdığın koda test ekle',
    en: 'Add tests for the code you wrote',
    de: 'Tests für den geschriebenen Code ergänzen',
  },
  {
    tr: 'İlk pull request’ini incelemeden geçir ve gelen yorumları uygula',
    en: 'Get your first pull request reviewed and act on the comments',
    de: 'Den ersten Pull Request reviewen lassen und die Kommentare umsetzen',
  },
  {
    tr: 'Bir başkasının pull request’ini incele ve en az bir yapıcı yorum yaz',
    en: 'Review someone else’s pull request and leave at least one useful comment',
    de: 'Den Pull Request einer anderen Person reviewen und mindestens einen hilfreichen Kommentar hinterlassen',
  },
  // Working in the open
  {
    tr: 'Kendini tanıtan kısa bir mesajı grup sohbetine gönder',
    en: 'Introduce yourself with a short message in the group chat',
    de: 'Sich mit einer kurzen Nachricht im Gruppenchat vorstellen',
  },
  {
    tr: 'Tanışma toplantısına katıl ve notlarını çıkar',
    en: 'Attend the kick-off meeting and take notes',
    de: 'Am Kick-off-Termin teilnehmen und Notizen machen',
  },
  {
    tr: 'Haftalık ilerleme notunu yaz ve mentoruna gönder',
    en: 'Write your weekly progress note and send it to your mentor',
    de: 'Den wöchentlichen Fortschrittsbericht schreiben und an den Mentor senden',
  },
  {
    tr: 'Takıldığın bir konuyu sormadan önce 30 dakika kendin araştır, sonra sor',
    en: 'When stuck, dig for 30 minutes yourself — then ask',
    de: 'Bei einem Problem erst 30 Minuten selbst recherchieren — dann fragen',
  },
  // Career side
  {
    tr: 'CV’ni güncelle ve mentorundan geri bildirim al',
    en: 'Update your CV and get your mentor’s feedback on it',
    de: 'Den Lebenslauf aktualisieren und Feedback vom Mentor einholen',
  },
  {
    tr: 'LinkedIn profilini güncelle: başlık, özet ve projeler',
    en: 'Update your LinkedIn profile: headline, summary and projects',
    de: 'Das LinkedIn-Profil aktualisieren: Titel, Zusammenfassung und Projekte',
  },
  // Closing out
  {
    tr: 'Kullandığınız teknolojilerden birini seç ve 10 dakikalık mini sunum yap',
    en: 'Pick one of the technologies you use and give a 10-minute talk on it',
    de: 'Eine der eingesetzten Technologien auswählen und einen 10-minütigen Kurzvortrag halten',
  },
  {
    tr: 'Öğrendiklerini kısa bir dokümana dök',
    en: 'Write up what you learned in a short document',
    de: 'Das Gelernte in einem kurzen Dokument festhalten',
  },
  {
    tr: 'Staj sonu raporunun ana hatlarını çıkar',
    en: 'Draft the outline of your final internship report',
    de: 'Die Gliederung des Abschlussberichts entwerfen',
  },
];

function hasTranslations(value) {
  return !!value && typeof value === 'object' && Object.keys(value).length > 0;
}

async function main() {
  const existing = await prisma.projectTaskTemplate.findMany({
    where: { projectId: null },
    select: { id: true, title: true, translations: true },
  });
  const byTitle = new Map(existing.map((t) => [t.title, t]));

  const missing = GOALS.filter((g) => !byTitle.has(g.tr));
  if (missing.length > 0) {
    await prisma.projectTaskTemplate.createMany({
      data: missing.map((g) => ({ projectId: null, title: g.tr, translations: g })),
    });
  }

  // Rows seeded before the pool was multilingual: fill in the wording they are
  // missing, and leave anything already translated alone.
  let translated = 0;
  for (const goal of GOALS) {
    const row = byTitle.get(goal.tr);
    if (!row || hasTranslations(row.translations)) continue;
    await prisma.projectTaskTemplate.update({ where: { id: row.id }, data: { translations: goal } });
    translated++;
  }

  console.log(
    `[seed-goal-templates] ${missing.length} created, ${translated} back-filled with translations ` +
      `(${GOALS.length} shared goals total).`
  );
}

main()
  .catch((e) => { console.error('[seed-goal-templates] error:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
