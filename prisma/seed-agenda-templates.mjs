// Idempotent seed of the guided-conversation library (#1841).
//
// A session agenda answers "what are we going to talk about" (schema:
// AgendaTemplate / AgendaTemplateItem, resolver: src/lib/agendas.ts). Until a
// tenant writes its own, the library is empty and every mentor improvises the
// same first conversation. This seeds the default org's library with the six
// conversations a mentoring arc is made of: kickoff, goal-setting, mid-point
// review, career conversation, feedback conversation, closing session.
//
// Each title and prompt is written in all three languages; the reader gets
// theirs (src/lib/agendasRule.ts resolves it on every render). The ENGLISH
// wording is the canonical `title` / `prompt` and therefore the dedupe key —
// matching on it keeps this run a no-op on a database that already has the set.
//
// Safe to run on every deploy (infra/deploy-prod.sh, next to
// seed-goal-templates). It does three things and all three are idempotent:
// insert the templates that are missing (with their items), give a template
// that somehow has no items its items, and fill in `translations` / `summary`
// on rows that have none. It never rewords or deletes a row an admin touched —
// an admin who archived a conversation keeps it archived, and one who renamed
// the English title has effectively renamed the row, which then stays as they
// left it (a rename can make this insert the original wording once more; say
// so rather than pretend otherwise).
//
// Modelled on prisma/seed-goal-templates.mjs. Like it, this is INTERNSHIP /
// mentoring content, so it belongs to the default org's library only — never a
// MARKETING tenant's (cross-world isolation). On the very first deploy the
// default org may not exist yet (backfill-organization.mjs creates it later in
// the same run); the rows then stay NULL, which the resolver reads as the
// default org.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** @typedef {{ en: string, tr: string, de: string }} Tri */

/**
 * @type {Array<{
 *   title: Tri,
 *   summary: Tri,
 *   items: Array<{ prompt: Tri, guidance?: string }>
 * }>}
 */
const TEMPLATES = [
  {
    title: {
      en: 'Kickoff — getting to know each other',
      tr: 'Tanışma — birbirimizi tanıyalım',
      de: 'Auftakt — sich kennenlernen',
    },
    summary: {
      en: 'The first conversation of a new pairing: who you both are, what the mentee hopes for, and how you will work together.',
      tr: 'Yeni bir eşleşmenin ilk görüşmesi: kim olduğunuz, mentee’nin beklentileri ve birlikte nasıl çalışacağınız.',
      de: 'Das erste Gespräch eines neuen Tandems: wer ihr seid, was sich der Mentee erhofft und wie ihr zusammenarbeiten werdet.',
    },
    items: [
      {
        prompt: {
          en: 'Introduce yourselves: background, current situation, one thing outside work',
          tr: 'Kendinizi tanıtın: geçmiş, şu anki durum, iş dışından bir şey',
          de: 'Stellt euch vor: Werdegang, aktuelle Situation, etwas außerhalb der Arbeit',
        },
        guidance: 'Go first and keep it short — the mentee mirrors the level of openness you set.',
      },
      {
        prompt: {
          en: 'What does the mentee hope to get out of this mentorship?',
          tr: 'Mentee bu mentorluktan ne bekliyor?',
          de: 'Was erhofft sich der Mentee von dieser Mentoring-Beziehung?',
        },
        guidance: 'Listen for the real goal behind the stated one (a job, a visa, confidence). Write it down verbatim — the goal-setting session starts from it.',
      },
      {
        prompt: {
          en: 'How will we work together: cadence, channel, response times, what to do when something comes up between sessions',
          tr: 'Nasıl çalışacağız: sıklık, kanal, yanıt süreleri, oturumlar arasında bir şey çıkarsa ne yapılacak',
          de: 'Wie arbeiten wir zusammen: Rhythmus, Kanal, Antwortzeiten, was zwischen den Terminen zu tun ist',
        },
        guidance: 'Agree on something concrete (e.g. every second Tuesday, messages answered within two working days) and put the first three dates in the calendar before you hang up.',
      },
      {
        prompt: {
          en: 'What is confidential between us, and what may the programme see?',
          tr: 'Aramızda neler gizli kalacak, programın görebileceği ne?',
          de: 'Was bleibt zwischen uns, und was darf das Programm sehen?',
        },
        guidance: 'Name the boundary explicitly. Session notes and evaluations are visible to the programme; a private goal is not.',
      },
      {
        prompt: {
          en: 'One small thing each of us will do before the next session',
          tr: 'Bir sonraki oturuma kadar her birimizin yapacağı küçük bir şey',
          de: 'Eine kleine Sache, die jeder von uns bis zum nächsten Termin erledigt',
        },
      },
    ],
  },
  {
    title: {
      en: 'Goal-setting — what success looks like',
      tr: 'Hedef belirleme — başarı nasıl görünecek',
      de: 'Ziele setzen — wie Erfolg aussieht',
    },
    summary: {
      en: 'Turn the hopes from the kickoff into two or three goals with success criteria and a target date.',
      tr: 'Tanışmadaki beklentileri başarı ölçütü ve hedef tarihi olan iki üç hedefe dönüştürün.',
      de: 'Die Erwartungen aus dem Auftakt in zwei bis drei Ziele mit Erfolgskriterien und Zieldatum übersetzen.',
    },
    items: [
      {
        prompt: {
          en: 'Where does the mentee want to be at the end of the programme — in one sentence?',
          tr: 'Mentee programın sonunda nerede olmak istiyor — tek cümleyle?',
          de: 'Wo will der Mentee am Ende des Programms stehen — in einem Satz?',
        },
      },
      {
        prompt: {
          en: 'Break it into two or three goals. For each: how will we know it is achieved?',
          tr: 'Bunu iki üç hedefe bölün. Her biri için: başarıldığını nereden anlayacağız?',
          de: 'In zwei bis drei Ziele aufteilen. Für jedes: Woran erkennen wir, dass es erreicht ist?',
        },
        guidance: 'Write the criteria into the goal itself (success criteria field). "Get better at interviews" becomes "two mock interviews done, feedback acted on, one real interview booked".',
      },
      {
        prompt: {
          en: 'Set a target date for each goal, and the first step for the coming two weeks',
          tr: 'Her hedef için bir hedef tarih ve önümüzdeki iki hafta için ilk adımı belirleyin',
          de: 'Für jedes Ziel ein Zieldatum und den ersten Schritt für die nächsten zwei Wochen festlegen',
        },
      },
      {
        prompt: {
          en: 'What could get in the way, and what will we do about it?',
          tr: 'Neler engel olabilir, ne yapacağız?',
          de: 'Was könnte im Weg stehen, und was tun wir dann?',
        },
        guidance: 'Time, money, paperwork, confidence. Naming the obstacle now makes it a plan item instead of a surprise.',
      },
      {
        prompt: {
          en: 'Who else can help — inside the programme or outside it?',
          tr: 'Başka kim yardımcı olabilir — program içinden ya da dışından?',
          de: 'Wer kann sonst noch helfen — im Programm oder außerhalb?',
        },
      },
    ],
  },
  {
    title: {
      en: 'Mid-point review — are we on track?',
      tr: 'Ara değerlendirme — yolunda mıyız?',
      de: 'Zwischenbilanz — sind wir auf Kurs?',
    },
    summary: {
      en: 'Halfway through: look at every goal honestly, adjust what is not working, and recommit to the rest.',
      tr: 'Yarı yolda: her hedefe dürüstçe bakın, işlemeyeni düzeltin, kalanına yeniden bağlanın.',
      de: 'Auf halbem Weg: jedes Ziel ehrlich ansehen, anpassen, was nicht funktioniert, und den Rest neu zusagen.',
    },
    items: [
      {
        prompt: {
          en: 'Go through each goal: progress so far, what moved it, what did not',
          tr: 'Her hedefi tek tek gözden geçirin: şimdiye kadarki ilerleme, neyin işe yaradığı, neyin yaramadığı',
          de: 'Jedes Ziel durchgehen: bisheriger Fortschritt, was geholfen hat, was nicht',
        },
        guidance: 'Update the progress figure on each goal together, in the session. The number is the mentee’s, not yours.',
      },
      {
        prompt: {
          en: 'Which goal should change — reworded, split, dropped, or replaced?',
          tr: 'Hangi hedef değişmeli — yeniden yazılmalı, bölünmeli, bırakılmalı ya da değiştirilmeli?',
          de: 'Welches Ziel sollte sich ändern — umformuliert, geteilt, gestrichen oder ersetzt werden?',
        },
        guidance: 'Dropping a goal that no longer matters is a result, not a failure. Say so.',
      },
      {
        prompt: {
          en: 'How is our way of working? Cadence, preparation, follow-through on both sides',
          tr: 'Çalışma şeklimiz nasıl? Sıklık, hazırlık, iki tarafın da sözünü tutması',
          de: 'Wie läuft unsere Zusammenarbeit? Rhythmus, Vorbereitung, Verbindlichkeit auf beiden Seiten',
        },
      },
      {
        prompt: {
          en: 'What does the mentee need from the mentor for the second half?',
          tr: 'İkinci yarı için mentee mentordan ne bekliyor?',
          de: 'Was braucht der Mentee vom Mentor für die zweite Hälfte?',
        },
      },
      {
        prompt: {
          en: 'The plan for the next four weeks, in dates',
          tr: 'Önümüzdeki dört haftanın planı, tarihleriyle',
          de: 'Der Plan für die nächsten vier Wochen, mit Terminen',
        },
      },
    ],
  },
  {
    title: {
      en: 'Career conversation — where to from here',
      tr: 'Kariyer görüşmesi — buradan nereye',
      de: 'Karrieregespräch — wohin von hier aus',
    },
    summary: {
      en: 'Step back from the day-to-day: strengths, options, the next role, and what the mentee needs to get there.',
      tr: 'Günlük işten bir adım geri çekilin: güçlü yanlar, seçenekler, bir sonraki rol ve oraya varmak için gerekenler.',
      de: 'Einen Schritt zurück vom Alltag: Stärken, Optionen, die nächste Rolle und was der Mentee dafür braucht.',
    },
    items: [
      {
        prompt: {
          en: 'What has the mentee enjoyed most so far, and what drained them?',
          tr: 'Mentee şimdiye kadar en çok neyden keyif aldı, ne yordu?',
          de: 'Was hat dem Mentee bisher am meisten Freude gemacht, was hat Kraft gekostet?',
        },
        guidance: 'Energy is a better compass than skill. Note the patterns, not the single tasks.',
      },
      {
        prompt: {
          en: 'Which strengths do others see in the mentee? Which do they see in themselves?',
          tr: 'Başkaları mentee’de hangi güçlü yanları görüyor? Kendisi hangilerini görüyor?',
          de: 'Welche Stärken sehen andere im Mentee? Welche sieht er oder sie selbst?',
        },
      },
      {
        prompt: {
          en: 'Two or three realistic next roles, and what each would ask of them',
          tr: 'İki üç gerçekçi sonraki rol ve her birinin ne isteyeceği',
          de: 'Zwei bis drei realistische nächste Rollen, und was jede verlangen würde',
        },
        guidance: 'Be concrete about the local market: titles, typical requirements, language level, the usual route in.',
      },
      {
        prompt: {
          en: 'CV, LinkedIn, portfolio: what is missing for those roles?',
          tr: 'CV, LinkedIn, portfolyo: o roller için eksik olan ne?',
          de: 'Lebenslauf, LinkedIn, Portfolio: Was fehlt für diese Rollen?',
        },
      },
      {
        prompt: {
          en: 'Who in the mentor’s network could the mentee talk to, and how will the introduction happen?',
          tr: 'Mentorun çevresinden mentee kiminle konuşabilir, tanıştırma nasıl olacak?',
          de: 'Mit wem aus dem Netzwerk des Mentors könnte der Mentee sprechen, und wie kommt der Kontakt zustande?',
        },
        guidance: 'Offer one introduction you will actually make this week, not a list you hope to make someday.',
      },
    ],
  },
  {
    title: {
      en: 'Feedback conversation — something specific to work on',
      tr: 'Geri bildirim görüşmesi — üzerinde çalışılacak somut bir şey',
      de: 'Feedbackgespräch — etwas Konkretes zum Arbeiten',
    },
    summary: {
      en: 'A structured conversation about one observed situation, in both directions, that ends with an agreed change.',
      tr: 'Gözlenen tek bir durum hakkında, iki yönlü, üzerinde anlaşılmış bir değişiklikle biten yapılandırılmış bir görüşme.',
      de: 'Ein strukturiertes Gespräch über eine beobachtete Situation, in beide Richtungen, das mit einer vereinbarten Änderung endet.',
    },
    items: [
      {
        prompt: {
          en: 'The situation: what happened, when, who was there — facts only',
          tr: 'Durum: ne oldu, ne zaman, kimler vardı — yalnızca olgular',
          de: 'Die Situation: Was ist passiert, wann, wer war dabei — nur Fakten',
        },
        guidance: 'Situation → behaviour → impact. Hold the interpretation back until the facts are agreed.',
      },
      {
        prompt: {
          en: 'The effect it had — on the work, on others, on the mentee',
          tr: 'Etkisi — işe, başkalarına, mentee’ye',
          de: 'Die Wirkung — auf die Arbeit, auf andere, auf den Mentee',
        },
      },
      {
        prompt: {
          en: 'How does the mentee see it? What was going on for them?',
          tr: 'Mentee bunu nasıl görüyor? Onun için neler oluyordu?',
          de: 'Wie sieht es der Mentee? Was war bei ihm oder ihr los?',
        },
        guidance: 'Ask before you advise. There is usually a reason you did not see.',
      },
      {
        prompt: {
          en: 'Feedback the other way: what should the mentor do differently?',
          tr: 'Tersi yönde geri bildirim: mentor neyi farklı yapmalı?',
          de: 'Feedback in die andere Richtung: Was sollte der Mentor anders machen?',
        },
      },
      {
        prompt: {
          en: 'One concrete change to try, and when we will look at it again',
          tr: 'Denenecek somut bir değişiklik ve ne zaman tekrar bakacağımız',
          de: 'Eine konkrete Änderung zum Ausprobieren, und wann wir wieder draufschauen',
        },
      },
    ],
  },
  {
    title: {
      en: 'Closing session — what we did, what comes next',
      tr: 'Kapanış oturumu — ne yaptık, sırada ne var',
      de: 'Abschlussgespräch — was wir geschafft haben, was als Nächstes kommt',
    },
    summary: {
      en: 'The last session of the programme: results against the goals, what the mentee takes with them, and how you stay in touch.',
      tr: 'Programın son oturumu: hedeflere göre sonuçlar, mentee’nin yanında götürdükleri ve nasıl iletişimde kalacağınız.',
      de: 'Der letzte Termin des Programms: Ergebnisse gemessen an den Zielen, was der Mentee mitnimmt und wie ihr in Kontakt bleibt.',
    },
    items: [
      {
        prompt: {
          en: 'Each goal: achieved, partly, or not — and what we learned either way',
          tr: 'Her hedef: başarıldı, kısmen ya da hayır — ve her durumda ne öğrendik',
          de: 'Jedes Ziel: erreicht, teilweise oder nicht — und was wir so oder so gelernt haben',
        },
        guidance: 'Close the goals in the system during the session so the record matches the conversation.',
      },
      {
        prompt: {
          en: 'What is the mentee proudest of? What surprised them?',
          tr: 'Mentee en çok neyle gurur duyuyor? Onu ne şaşırttı?',
          de: 'Worauf ist der Mentee am meisten stolz? Was hat überrascht?',
        },
      },
      {
        prompt: {
          en: 'The next three months without the programme: what is the plan, and who holds the mentee to it?',
          tr: 'Programsız geçecek üç ay: plan ne, mentee’yi buna kim bağlı tutacak?',
          de: 'Die nächsten drei Monate ohne Programm: Was ist der Plan, und wer hält den Mentee daran?',
        },
      },
      {
        prompt: {
          en: 'Feedback on the programme itself — what should the next pairing get that we did not?',
          tr: 'Programın kendisine geri bildirim — bir sonraki eşleşme bizim almadığımız neyi almalı?',
          de: 'Feedback zum Programm selbst — was sollte das nächste Tandem bekommen, das wir nicht hatten?',
        },
        guidance: 'Pass it on: the programme survey, or a line to the coordinator. This is where the next cohort improves.',
      },
      {
        prompt: {
          en: 'How, and how often, will we stay in touch?',
          tr: 'Nasıl ve ne sıklıkla iletişimde kalacağız?',
          de: 'Wie und wie oft bleiben wir in Kontakt?',
        },
      },
    ],
  },
];

function hasTranslations(value) {
  return !!value && typeof value === 'object' && Object.keys(value).length > 0;
}

async function defaultOrgId() {
  const org = await prisma.organization.findUnique({
    where: { slug: process.env.DEFAULT_ORG_SLUG || 'default' },
    select: { id: true },
  });
  return org?.id ?? null;
}

async function main() {
  const orgId = await defaultOrgId();
  const existing = await prisma.agendaTemplate.findMany({
    // The default org's library: its own rows plus the not-yet-backfilled NULLs.
    where: { OR: orgId ? [{ orgId }, { orgId: null }] : [{ orgId: null }] },
    select: { id: true, title: true, translations: true, summary: true, _count: { select: { items: true } } },
  });
  const byTitle = new Map(existing.map((t) => [t.title, t]));

  let created = 0;
  let itemsAdded = 0;
  let backfilled = 0;
  for (const template of TEMPLATES) {
    const itemsCreate = template.items.map((item, order) => ({
      order,
      prompt: item.prompt.en,
      translations: item.prompt,
      guidance: item.guidance ?? null,
    }));
    const row = byTitle.get(template.title.en);
    if (!row) {
      await prisma.agendaTemplate.create({
        data: {
          orgId,
          audience: 'PAIR',
          title: template.title.en,
          translations: template.title,
          summary: template.summary,
          items: { create: itemsCreate },
        },
      });
      created++;
      continue;
    }
    // A template that lost its items (a half-failed earlier run) gets them.
    if (row._count.items === 0) {
      await prisma.agendaTemplateItem.createMany({ data: itemsCreate.map((i) => ({ ...i, templateId: row.id })) });
      itemsAdded += itemsCreate.length;
    }
    // Rows seeded before the library was multilingual: fill in what is missing,
    // leave anything already written alone.
    const data = {};
    if (!hasTranslations(row.translations)) data.translations = template.title;
    if (!hasTranslations(row.summary)) data.summary = template.summary;
    if (Object.keys(data).length > 0) {
      await prisma.agendaTemplate.update({ where: { id: row.id }, data });
      backfilled++;
    }
  }

  console.log(
    `[seed-agenda-templates] ${created} created, ${itemsAdded} items added to existing templates, ` +
      `${backfilled} back-filled with translations (${TEMPLATES.length} conversations total).`
  );
}

main()
  .catch((e) => { console.error('[seed-agenda-templates] error:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
