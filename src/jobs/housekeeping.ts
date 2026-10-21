// Hourly and nightly housekeeping (#1677).
//
// Idempotency: every one of these is a check or a delete by age — a second run
// reads the same health or finds nothing left to delete.
import { registerJob } from '@/lib/jobs/registry';
import { counters, SWEEP_OPTS } from './summary';
import { runEmailHealthCheck } from '@/services/emailService';
import { expireDrafts } from '@/lib/outboundDrafts';
import { purgeExpiredTrustedDevices } from '@/lib/trustedDevice';
import { purgeExpiredLoginLinks } from '@/lib/magicLink';
import { purgeStaleSignInDevices } from '@/lib/signInDevice';
import { purgeExpiredIdempotencyKeys } from '@/lib/api/v1Write';
import { sweepAiArtifacts } from '@/lib/ai/artifacts';
import { runRetentionPrune } from '@/lib/retentionEntries';

export function registerHousekeepingJobs(): void {
  registerJob('email.healthCheck', async () => {
    await runEmailHealthCheck();
  }, SWEEP_OPTS);
  registerJob('outbound.expireDrafts', async () => ({ expired: await expireDrafts() }), SWEEP_OPTS);
  registerJob('auth.trustedDevicePurge', async () => {
    const devices = await purgeExpiredTrustedDevices();
    return {
      trustedDevices: devices.devices,
      refreshGrants: devices.grants,
      loginLinks: await purgeExpiredLoginLinks(),
      signInDevices: await purgeStaleSignInDevices(),
      idempotencyKeys: await purgeExpiredIdempotencyKeys(),
    };
  }, SWEEP_OPTS);
  registerJob('ai.artifactRetention', async () => counters(await sweepAiArtifacts()), SWEEP_OPTS);
  // Deletes rows; bounded per run (maxPerRun), so a rerun continues the backlog.
  registerJob('retention.prune', async () => counters(await runRetentionPrune()), SWEEP_OPTS);
}
