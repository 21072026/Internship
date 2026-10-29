// Every notification channel, one adapter each (#1711). The router looks a
// channel up here and nowhere else: adding a channel is an adapter file plus
// one line below (and its name in NOTIFICATION_CHANNELS), never a router edit.
import type { NotificationChannel } from '../catalog';
import type { ChannelAdapter } from './types';
import { inAppAdapter } from './inApp';
import { emailAdapter } from './email';
import { chatAdapter } from './chat';

export const CHANNEL_ADAPTERS: Readonly<Record<NotificationChannel, ChannelAdapter>> = {
  inApp: inAppAdapter,
  email: emailAdapter,
  chat: chatAdapter,
};

export type { ChannelAdapter, ChannelDelivery, ChannelOutcome, SkipReason } from './types';
