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
// Safe to run on every deploy. MySQL does not enforce the
// @@unique([projectId, title]) key across NULL projectIds, so uniqueness is
// checked here instead of relying on skipDuplicates.
//
// Titles are Turkish: that is the language the goals are handed out in (the
// pipeline stages are Turkish too), and a template is free text shown as-is —
// there is no per-locale variant of a pool entry. A mentor can rename or delete
// project-scoped copies; these shared ones stay.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// The first-week set from the onboarding wizard's own description — read the
// project, find a bug, find a feature — plus the rest of a typical internship
// arc: getting set up, working in the open, and closing out.
const GOALS = [
  // Getting set up
  'Projeyi yerelde çalıştır: depoyu klonla, kur ve ayağa kaldır',
  'README’i oku; eksik veya yanlış bulduğun bir yeri düzelt',
  'Projenin veri modelini incele ve aklına takılan 3 soruyu yaz',
  'Bir özelliği baştan sona takip et ve nasıl çalıştığını kısaca anlat',
  // Working on it
  'Bir hata (bug) bul ve nasıl tekrar edildiğini adım adım yaz',
  'Bulduğun hatayı düzelt ve pull request aç',
  'Küçük bir özellik öner; neden gerektiğini bir paragrafla anlat',
  'Önerdiğin küçük özelliği geliştir ve pull request aç',
  'Yazdığın koda test ekle',
  'İlk pull request’ini incelemeden geçir ve gelen yorumları uygula',
  'Bir başkasının pull request’ini incele ve en az bir yapıcı yorum yaz',
  // Working in the open
  'Kendini tanıtan kısa bir mesajı grup sohbetine gönder',
  'Tanışma toplantısına katıl ve notlarını çıkar',
  'Haftalık ilerleme notunu yaz ve mentoruna gönder',
  'Takıldığın bir konuyu sormadan önce 30 dakika kendin araştır, sonra sor',
  // Career side
  'CV’ni güncelle ve mentorundan geri bildirim al',
  'LinkedIn profilini güncelle: başlık, özet ve projeler',
  // Closing out
  'Kullandığınız teknolojilerden birini seç ve 10 dakikalık mini sunum yap',
  'Öğrendiklerini kısa bir dokümana dök',
  'Staj sonu raporunun ana hatlarını çıkar',
];

async function main() {
  const existing = await prisma.projectTaskTemplate.findMany({
    where: { projectId: null },
    select: { title: true },
  });
  const known = new Set(existing.map((t) => t.title));
  const missing = GOALS.filter((title) => !known.has(title));

  if (missing.length === 0) {
    console.log(`[seed-goal-templates] all ${GOALS.length} shared goal templates already present.`);
    return;
  }

  await prisma.projectTaskTemplate.createMany({
    data: missing.map((title) => ({ projectId: null, title })),
  });
  console.log(`[seed-goal-templates] created ${missing.length} of ${GOALS.length} shared goal templates.`);
}

main()
  .catch((e) => { console.error('[seed-goal-templates] error:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
