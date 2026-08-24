// Idempotent seed of the contributor terms text (#1025).
//
// The terms live in the database as versioned rows (see the model comments and
// docs/legal/contributor-terms-in-app.md). This script puts v1.0 there, taken
// from CONTRIBUTING.md § Contributor terms (IP) — the same wording the PR
// template already asks contributors to confirm, so the in-app acceptance and
// the paper trail say one thing.
//
// Safe on every deploy: a (key, version, locale) that already exists is left
// ALONE, never updated. Editing an accepted text in place would silently change
// what people agreed to — a new wording is a new version, which is a new row
// and a fresh acceptance.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const KEY = 'default';
const VERSION = '1.0';
// The date the wording in CONTRIBUTING.md has been in force.
const EFFECTIVE_FROM = new Date('2026-07-01T00:00:00Z');

// EN is the binding text. TR/DE are provided so nobody has to accept terms in a
// language they do not read — but the one that governs is recorded on the row,
// and the UI says so when it is showing a translation.
const EN = `## Contributor terms (IP)

Accepting these terms is how contributions to Internship CRM are licensed. The same
wording is in \`CONTRIBUTING.md\` and is confirmed again on every pull request.

- **Sole rights holder.** All rights in Internship CRM are held by **Mehmet Erşahin**
  (a natural person, not a company). Only the rights holder may license the software.
- **Your contribution.** You license your contribution under **AGPL-3.0-or-later** and
  grant the rights holder an **exclusive, perpetual, worldwide, sub-licensable right to
  use it** (assignment of economic rights where the law permits; under German copyright
  law the copyright itself cannot be transferred, § 29 UrhG, so the mechanism is an
  exclusive exploitation right, § 31 (3) UrhG).
- **Dual licensing.** You agree the rights holder may also offer your contribution under
  a separate **commercial license**, without AGPL obligations.
- **No claims.** Contributions are made within the mentorship, without additional
  remuneration, and give rise to **no copyright, license, fee, partnership, or equity
  claim** over the application.
- **Portfolio grant-back.** You keep the right to present your own contributions in a
  personal portfolio or for educational purposes (non-commercial).
- **Originality.** You confirm your contribution is your own work and does not infringe
  third-party rights. Don't paste in code you don't have the right to contribute.
- **Beyond the mentorship.** Paid, external, or corporate contributors sign a short
  written agreement instead of relying on this acceptance — see
  \`docs/legal/cla-contributor-agreement.md\`.

Trademarks are **not** covered by the AGPL: the "Internship CRM" name, logo, and the
\`crm.ersah.in\` domain stay with the rights holder.

Accepting here covers your contributions to this platform. Individual projects may ask
you to accept their own terms when you join them, and each pull request confirms the
specific contribution it contains.`;

const TR = `## Katkı şartları (fikri mülkiyet)

Internship CRM'e yapılan katkılar bu şartlarla lisanslanır. Aynı metin
\`CONTRIBUTING.md\` içinde yer alır ve her pull request'te yeniden onaylanır.

> **Bağlayıcı metin İngilizcedir.** Aşağıdaki çeviri bilgilendirme amaçlıdır;
> bir farklılık olursa İngilizce metin geçerlidir.

- **Tek hak sahibi.** Internship CRM üzerindeki tüm haklar **Mehmet Erşahin**'e
  aittir (bir şirkete değil, gerçek kişiye). Yazılımı yalnızca hak sahibi lisanslayabilir.
- **Katkın.** Katkını **AGPL-3.0-or-later** ile lisanslar ve hak sahibine
  **münhasır, süresiz, dünya çapında ve alt lisans verilebilir bir kullanım hakkı**
  tanırsın (hukukun izin verdiği ölçüde mali hakların devri; Alman telif hukukunda
  telif hakkının kendisi devredilemediği için — § 29 UrhG — mekanizma münhasır
  yararlanma hakkıdır, § 31 (3) UrhG).
- **Çift lisanslama.** Hak sahibinin katkını AGPL yükümlülükleri olmadan ayrı bir
  **ticari lisansla** da sunabileceğini kabul edersin.
- **Talep yok.** Katkılar mentorluk kapsamında, ek bir ücret olmaksızın yapılır ve
  uygulama üzerinde **telif, lisans, ücret, ortaklık veya hisse talebi doğurmaz**.
- **Portföy hakkı.** Kendi katkılarını kişisel portföyünde veya eğitim amacıyla
  (ticari olmayan) sunma hakkın sende kalır.
- **Özgünlük.** Katkının kendi eserin olduğunu ve üçüncü kişilerin haklarını
  ihlal etmediğini beyan edersin. Katkı olarak sunma hakkın olmayan kodu yapıştırma.
- **Mentorluk dışı.** Ücretli, harici veya kurumsal katkıcılar bu onaya dayanmak
  yerine kısa bir yazılı sözleşme imzalar — bkz. \`docs/legal/cla-contributor-agreement.md\`.

Markalar AGPL kapsamında **değildir**: "Internship CRM" adı, logosu ve
\`crm.ersah.in\` alan adı hak sahibinde kalır.

Buradaki onay bu platformdaki katkılarını kapsar. Projeler sen katıldığında kendi
şartlarını da isteyebilir; her pull request ise içerdiği somut katkıyı onaylar.`;

const DE = `## Beitragsbedingungen (Urheberrecht)

Beiträge zu Internship CRM werden zu diesen Bedingungen lizenziert. Derselbe Text
steht in \`CONTRIBUTING.md\` und wird bei jedem Pull Request erneut bestätigt.

> **Verbindlich ist die englische Fassung.** Diese Übersetzung dient der
> Information; bei Abweichungen gilt der englische Text.

- **Alleiniger Rechteinhaber.** Alle Rechte an Internship CRM liegen bei
  **Mehmet Erşahin** (eine natürliche Person, kein Unternehmen). Nur der
  Rechteinhaber darf die Software lizenzieren.
- **Dein Beitrag.** Du lizenzierst deinen Beitrag unter **AGPL-3.0-or-later** und
  räumst dem Rechteinhaber ein **ausschließliches, zeitlich unbegrenztes, weltweites
  und unterlizenzierbares Nutzungsrecht** ein (Übertragung der wirtschaftlichen
  Rechte, soweit gesetzlich zulässig; da das Urheberrecht selbst nach deutschem
  Recht nicht übertragbar ist — § 29 UrhG — erfolgt dies als ausschließliches
  Nutzungsrecht, § 31 Abs. 3 UrhG).
- **Duale Lizenzierung.** Du stimmst zu, dass der Rechteinhaber deinen Beitrag auch
  unter einer separaten **kommerziellen Lizenz** ohne AGPL-Pflichten anbieten darf.
- **Keine Ansprüche.** Beiträge erfolgen im Rahmen des Mentorings, ohne zusätzliche
  Vergütung, und begründen **keine Urheber-, Lizenz-, Vergütungs-, Gesellschafts-
  oder Beteiligungsansprüche** an der Anwendung.
- **Portfolio-Rückrecht.** Du behältst das Recht, deine eigenen Beiträge in einem
  persönlichen Portfolio oder zu Bildungszwecken (nicht kommerziell) zu zeigen.
- **Originalität.** Du bestätigst, dass dein Beitrag dein eigenes Werk ist und keine
  Rechte Dritter verletzt. Füge keinen Code ein, den du nicht beitragen darfst.
- **Außerhalb des Mentorings.** Bezahlte, externe oder unternehmerische Beitragende
  unterzeichnen statt dieser Zustimmung eine kurze schriftliche Vereinbarung — siehe
  \`docs/legal/cla-contributor-agreement.md\`.

Marken sind **nicht** von der AGPL erfasst: der Name „Internship CRM", das Logo und
die Domain \`crm.ersah.in\` verbleiben beim Rechteinhaber.

Diese Zustimmung gilt für deine Beiträge auf dieser Plattform. Einzelne Projekte
können beim Beitritt eigene Bedingungen verlangen, und jeder Pull Request bestätigt
den konkreten Beitrag, den er enthält.`;

const ROWS = [
  { locale: 'en', isAuthoritative: true, body: EN },
  { locale: 'tr', isAuthoritative: false, body: TR },
  { locale: 'de', isAuthoritative: false, body: DE },
];

async function main() {
  let created = 0;
  for (const row of ROWS) {
    const existing = await prisma.contributorTerms.findUnique({
      where: { key_version_locale: { key: KEY, version: VERSION, locale: row.locale } },
    });
    if (existing) continue;
    await prisma.contributorTerms.create({
      data: { key: KEY, version: VERSION, effectiveFrom: EFFECTIVE_FROM, ...row },
    });
    created++;
  }
  console.log(`[seed-contributor-terms] ${created} of ${ROWS.length} locales created for ${KEY} v${VERSION}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
