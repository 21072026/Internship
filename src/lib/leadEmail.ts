// Which address a screen shows for a person (client-safe, no imports).
//
// A marketing lead's user row carries a generated stand-in address on the
// `import.local` domain — it can never sign in or be mailed — and its REAL
// address sits on its account (`Company.contactEmail`). A screen that lists
// people shows the real one; the stand-in is an implementation detail.
const STAND_IN_SUFFIX = '@import.local';

export function shownEmail(email: string, accountContactEmail?: string | null): string {
  return email.toLowerCase().endsWith(STAND_IN_SUFFIX) && accountContactEmail ? accountContactEmail : email;
}
