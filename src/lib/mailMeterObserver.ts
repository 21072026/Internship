import { logger } from '@/lib/logger';
import {
  budgetConfig,
  budgetNameFor,
  classifySmtpError,
  type BudgetConfig,
  type MailChannel,
  type MailLane,
} from '@/lib/mailDeliveryRule';
import * as budgetStore from '@/lib/mailBudgetStore';

// The shared send budget in OBSERVE mode (#2941): an instrument beside every
// real send that logs what the budget WOULD have refused —
// `mail_meter.would_refuse` with the lane and the wait — without ever refusing,
// delaying or failing a mail. `MAIL_METER_MODE=off` leaves the meter untouched.
//
// AN INSTRUMENT MUST NOT LOAD WHAT IT MEASURES
//   A broadcast hands hundreds of sends to `sendEmail()` inside one
//   `Promise.all`. Had each of them run its own meter statements, they would all
//   queue on the one `MailBudget` row lock while holding pool connections, and
//   starve the reads the sends themselves need (the P2024 that path already
//   hit once). So every meter statement of this process runs through ONE
//   promise chain — at most one meter statement in flight per process — and
//   once more than `maxBacklog` observations are waiting, new ones are dropped
//   and counted (`mail_meter.dropped`, logged once the chain drains). A granted
//   send costs one statement; a refused one three (spend, read the wait,
//   charge); a delivery decays the throttle ladder only while this process has
//   seen it raised.
//
// Every task swallows its own errors: an instrument that breaks must not break
// the thing it measures. Log lines carry the lane, the category, the channel
// and numbers — never an address.

export interface MeterSubject {
  lane: MailLane;
  category?: string;
  transport: MailChannel;
}

export type MeterStore = Pick<typeof budgetStore, 'spendToken' | 'chargeToken' | 'pauseBudget' | 'decayPause'>;

export interface MeterObserverOptions {
  env?: Record<string, string | undefined>;
  /** Budget row per channel; defaults to `budgetNameFor`. Tests use their own. */
  nameFor?: (channel: MailChannel) => string;
  store?: MeterStore;
  maxBacklog?: number;
}

export interface MeterObserver {
  /** Before a real send: spend (or, in observe mode, charge) one token. */
  spend(subject: MeterSubject): void;
  /** After a real send: decay the ladder on success, pause on a relay-wide failure. */
  outcome(subject: MeterSubject, error: unknown): void;
  /** Resolves once every observation queued so far has run (tests, shutdown). */
  idle(): Promise<void>;
}

export const DEFAULT_METER_BACKLOG = 32;

export function createMeterObserver(opts: MeterObserverOptions = {}): MeterObserver {
  const env = opts.env ?? process.env;
  const nameFor = opts.nameFor ?? budgetNameFor;
  const store = opts.store ?? budgetStore;
  const maxBacklog = Math.max(1, opts.maxBacklog ?? DEFAULT_METER_BACKLOG);

  const configs = new Map<MailChannel, BudgetConfig>();
  const config = (channel: MailChannel): BudgetConfig => {
    let cfg = configs.get(channel);
    if (!cfg) {
      cfg = budgetConfig(env, channel);
      configs.set(channel, cfg);
    }
    return cfg;
  };

  // Budgets this process has seen paused (its own throttle, or a refusal that
  // read a raised ladder): only those are decayed on a delivery.
  const pausedSeen = new Set<string>();

  let chain: Promise<void> = Promise.resolve();
  let backlog = 0;
  let dropped = 0;

  function enqueue(task: () => Promise<void>): void {
    if (backlog >= maxBacklog) {
      dropped++;
      return;
    }
    backlog++;
    chain = chain
      .then(task)
      .catch((e) => {
        logger.warning('mail_meter.error', { error: e instanceof Error ? e.name : 'unknown' });
      })
      .finally(() => {
        backlog--;
        if (backlog === 0 && dropped > 0) {
          logger.info('mail_meter.dropped', { count: dropped });
          dropped = 0;
        }
      });
  }

  return {
    spend(subject) {
      const cfg = config(subject.transport);
      if (cfg.mode === 'off') return;
      const name = nameFor(subject.transport);
      enqueue(async () => {
        const outcome = await store.spendToken(subject.lane, cfg, name);
        if (outcome.allowed && outcome.reason === 'spent') return;
        if (outcome.reason === 'db_error') {
          logger.warning('mail_meter.unavailable', {
            lane: subject.lane,
            category: subject.category,
            channel: subject.transport,
            wouldSend: outcome.allowed,
          });
          return;
        }
        if ((outcome.pauseLevel ?? 0) > 0) pausedSeen.add(name);
        logger.info('mail_meter.would_refuse', {
          lane: subject.lane,
          category: subject.category,
          channel: subject.transport,
          waitMs: outcome.waitMs,
          // 'refused' (the rate) or 'daily_cap' (a BULK mail past 90 % of
          // MAIL_DAILY_CAP, #2951).
          reason: outcome.reason,
        });
        // The mail goes anyway, so the meter is charged for it: it must describe
        // what the relay actually received, or every later line would understate.
        await store.chargeToken(cfg, name);
      });
    },

    outcome(subject, error) {
      const cfg = config(subject.transport);
      if (cfg.mode === 'off') return;
      const name = nameFor(subject.transport);
      if (!error) {
        if (!pausedSeen.has(name)) return;
        enqueue(async () => {
          if (!(await store.decayPause(name))) pausedSeen.delete(name);
        });
        return;
      }
      const cls = classifySmtpError(error);
      logger.info('mail_meter.failure_class', {
        lane: subject.lane,
        category: subject.category,
        channel: subject.transport,
        kind: cls.kind,
        reason: cls.reason,
      });
      if (!cls.relayWide) return;
      pausedSeen.add(name);
      enqueue(() => store.pauseBudget(cfg, name));
    },

    idle() {
      return chain;
    },
  };
}
