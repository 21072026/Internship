// Idempotent document review-status backfill (#1859), run on every deploy.
//
// Document.reviewStatus arrived with a default of PENDING, so every document
// older than the column reads PENDING. Under approvalMode NONE that changes
// nothing (src/lib/documentReview.ts: NONE ignores PENDING), but a document's
// status badge would be wrong, and a requirement later switched to a chain
// would judge yesterday's files as unreviewed. This marks APPROVED exactly the
// documents that never entered a chain: PENDING with no DocumentReview row.
// A document waiting in a real chain has review rows and is left alone, so a
// second run reports updated=0. Never deletes, never touches a decided row.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
async function main() {
  const { count } = await prisma.document.updateMany({
    where: { reviewStatus: 'PENDING', reviews: { none: {} } },
    data: { reviewStatus: 'APPROVED' },
  });
  console.log(`backfill-document-reviews: updated=${count}`);
}
main().catch((error) => { console.error('backfill-document-reviews failed:', error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
