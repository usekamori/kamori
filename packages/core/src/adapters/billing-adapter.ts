/**
 * BillingAdapter — plan enforcement and usage metering.
 *
 * Self-hosted: always allows all operations (NoBillingAdapter).
 * Cloud: Stripe plan gating and metered billing via StripeAdapter (private repo).
 */
export interface BillingAdapter {
  /** Check whether the given project is allowed to ingest logs. Returns true for self-hosted. */
  checkIngestAccess(projectId: string): Promise<boolean>;
  /** Report bytes and lines ingested for metered billing. No-op for self-hosted. */
  reportUsage(projectId: string, bytes: number, lines: number): Promise<void>;
}

/** Self-hosted billing adapter — always allows access, never reports usage. */
export class NoBillingAdapter implements BillingAdapter {
  async checkIngestAccess(_projectId: string): Promise<boolean> {
    return true;
  }

  async reportUsage(_projectId: string, _bytes: number, _lines: number): Promise<void> {
    // no-op
  }
}
