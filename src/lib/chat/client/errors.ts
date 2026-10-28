/**
 * A platform refusal, carrying a short code safe to store in
 * ChatDelivery.error / ChatWorkspace.lastError — never a token, never a body.
 */
export class ChatClientError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
