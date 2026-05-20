/**
 * RetentionAdapter — log retention policy.
 *
 * Self-hosted: purge logs older than RETENTION_DAYS env var.
 * Cloud: plan-based retention (3/30/90 days by plan tier) via PlanRetentionAdapter.
 */
export interface RetentionAdapter {
  /**
   * Returns the cutoff ISO date string: logs older than this should be purged.
   * Returns null when retention is disabled (keep forever).
   */
  getCutoffDate(): string | null;
}

/**
 * Self-hosted retention adapter — uses the RETENTION_DAYS env var.
 * When retentionDays is 0 (the default), retention is disabled.
 */
export class EnvRetentionAdapter implements RetentionAdapter {
  constructor(private readonly retentionDays: number) {}

  getCutoffDate(): string | null {
    if (this.retentionDays <= 0) return null;
    return new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
  }
}
