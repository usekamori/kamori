/**
 * EmailAdapter — transactional email sending.
 *
 * Self-hosted: silently discards all email (NoopEmailAdapter).
 * Cloud: Resend API via ResendAdapter (private repo).
 */
export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
}

export interface EmailAdapter {
  sendEmail(opts: EmailOptions): Promise<void>;
}

/** Self-hosted email adapter — silently discards all email. */
export class NoopEmailAdapter implements EmailAdapter {
  async sendEmail(_opts: EmailOptions): Promise<void> {
    // no-op
  }
}
