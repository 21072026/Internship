/**
 * Who operates THIS deployment (#1396).
 *
 * Two legal duties want the same handful of facts, so they are read from one
 * place: the imprint (§5 DDG, the former §5 TMG) that a commercial site aimed
 * at Germany has to publish, and the controller identity GDPR Art. 13 requires
 * at the point of collection. Until now neither existed — the privacy notice
 * shipped with a placeholder saying the operator would fill them in before
 * production use, and production had been live for months.
 *
 * WHY THE ENVIRONMENT AND NOT A CONSTANT
 *   This project is AGPL and other people run their own instances. A name and a
 *   postal address written into the source would print OUR operator's details on
 *   THEIR imprint page — wrong for them, and for a natural person's home address
 *   in a public repository, worse than wrong. The identity belongs to the
 *   deployment, not to the code, so it comes from the deployment's env file.
 *
 * Server-side only, deliberately not `NEXT_PUBLIC_*`: /imprint and /privacy are
 * server components, so these values never need to reach the browser bundle.
 */

export interface OperatorIdentity {
  /** Natural person or legal entity operating this instance. */
  name: string;
  /** Postal address, already split into display lines. May be empty. */
  address: string[];
  /** A working address a visitor can actually write to (§5(1)(2) DDG). */
  email: string;
  phone?: string;
  /** Person responsible for the content, where that is not the operator (§18(2) MStV). */
  responsible?: string;
  /** VAT identification number (§27a UStG), for a VAT-registered operator. */
  vatId?: string;
  /** Register court and number, for a registered legal entity. */
  register?: string;
  /** Data protection officer's contact, where one is appointed (GDPR Art. 37). */
  dpo?: string;
}

type Env = Record<string, string | undefined>;

function value(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

/**
 * Split a one-line env value into address lines. A `.env` file cannot hold real
 * newlines, so `|` is the separator that gets used in practice; literal newlines
 * are accepted too for whoever sets the variable another way.
 */
function addressLines(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[|\n]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The configured identity, or `null` when this deployment has not published one.
 *
 * Name and email are the floor: a controller nobody can name and nobody can
 * write to is the gap this exists to close, and rendering half of it would look
 * like an oversight rather than a decision. The postal address is NOT part of
 * that floor on purpose — it is required for a German-facing commercial imprint
 * and `.env.example` says so, but withholding the whole page (and with it the
 * contact channel) because one variable is still pending would keep the worse
 * state in place for longer. What is set renders; what is not, does not.
 */
export function operatorIdentity(env: Env = process.env): OperatorIdentity | null {
  const name = value(env.OPERATOR_NAME);
  const email = value(env.OPERATOR_EMAIL);
  if (!name || !email) return null;

  return {
    name,
    email,
    address: addressLines(env.OPERATOR_ADDRESS),
    phone: value(env.OPERATOR_PHONE),
    responsible: value(env.OPERATOR_RESPONSIBLE),
    vatId: value(env.OPERATOR_VAT_ID),
    register: value(env.OPERATOR_REGISTER),
    dpo: value(env.OPERATOR_DPO),
  };
}
