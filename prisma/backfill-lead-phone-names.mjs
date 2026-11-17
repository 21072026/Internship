// Rename the phone-keyed leads that were named after their phone key (#3821).
//
// WHAT WENT IN
//   A sales rep's hand-typed lead may carry only a phone number (#3647). Its
//   lead person is keyed on `tel.<normalized digits>`, and when the form named
//   no contact the importer used that key as `User.fullName` — so the board,
//   the lead page and every list showed "tel.4930…" where a name belongs.
//   The writer now names such a lead after its account
//   (`leadFallbackName()` in src/lib/marketingImport.ts); this fixes the rows
//   written before that.
//
// WHAT THIS DOES
//   For every MENTEE whose `fullName` is exactly a phone key AND whose address
//   is the importer's stand-in for that same key (`<key>.<hash>@import.local`)
//   — i.e. a name nobody typed — sets `fullName` to the account's contact name,
//   else the account's name. A lead with no account, or an account with no
//   name, is left as it is. A name a person typed is never touched: it is not
//   a phone key, or it does not match the stand-in address.
//
// Idempotent: a renamed row no longer matches. Dry-run by default; `--apply`
// writes.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const PHONE_KEY = /^tel\.\d{7,10}$/;
const STAND_IN_DOMAIN = '@import.local';

async function main() {
  const rows = await prisma.user.findMany({
    where: { role: 'MENTEE', fullName: { startsWith: 'tel.' }, email: { endsWith: STAND_IN_DOMAIN } },
    select: { id: true, fullName: true, email: true, company: { select: { name: true, contactName: true } } },
  });
  let renamed = 0;
  let skipped = 0;
  for (const row of rows) {
    const key = row.fullName;
    if (!PHONE_KEY.test(key) || !row.email.startsWith(`${key}.`)) continue;
    const name = (row.company?.contactName ?? '').trim() || (row.company?.name ?? '').trim();
    if (!name) {
      skipped++;
      continue;
    }
    if (APPLY) {
      // Guarded on the old value: a rename that happened since is kept.
      const { count } = await prisma.user.updateMany({ where: { id: row.id, fullName: key }, data: { fullName: name } });
      renamed += count;
    } else {
      renamed++;
    }
  }
  console.log(`backfill-lead-phone-names: ${APPLY ? 'renamed' : 'would rename'}=${renamed} skipped_no_account_name=${skipped}`);
}

main()
  .catch((error) => {
    console.error('backfill-lead-phone-names failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
