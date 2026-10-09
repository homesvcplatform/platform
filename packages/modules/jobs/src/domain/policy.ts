// Lifecycle policy values (Phase 1 06 §3–§4, 02 §5, ADR-026 #6). Values are configuration, injected by the app.
// These defaults are FIXTURE VALUES, NOT FINAL: they exist so local / CI runs are deterministic until the config
// module stores the real values.

export interface LifecyclePolicy {
  /** Scheduled visits start matching this long before the window starts (ASAP: immediately). */
  readonly matchLeadMs: number;
  /** MATCHING longer than this → UNFULFILLED (ASAP / scheduled). */
  readonly asapMatchSlaMs: number;
  readonly scheduledMatchSlaMs: number;
  /** ASAP bookings get a window of this length starting now. */
  readonly asapWindowMs: number;
  /** Slot bookings: window length bounds, start rounding and how far ahead. */
  readonly slotMinMs: number;
  readonly slotMaxMs: number;
  readonly slotStepMs: number;
  readonly slotMaxAheadMs: number;
  /** Technician not departed / not arrived by window start + grace → assignment NO_SHOW, visit back to MATCHING. */
  readonly techNoShowGraceMs: number;
  /** Customer not responding: wait this long after a wait starts → CUSTOMER_NO_SHOW. */
  readonly waitGraceMs: number;
  /** IN_PROGRESS longer than this after arrival → ops check-in (needs_attention). */
  readonly maxVisitMs: number;
  /** L2 opens at max(accepted, window start − lead) and closes at visit terminal + after (02 §5). */
  readonly disclosureOpenLeadMs: number;
  readonly disclosureCloseAfterMs: number;
  /** L3 fields stay visible this long after the assignment ends (X-30). */
  readonly l3RetentionMs: number;
  /** Wrong start / completion code entries before the code locks (06 §3). */
  readonly codeMaxAttempts: number;
  /** Technician release without a late-release mark until window start − lead (06 §4). */
  readonly freeReleaseLeadMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const FIXTURE_LIFECYCLE_POLICY: LifecyclePolicy = Object.freeze({
  matchLeadMs: 2 * HOUR,
  asapMatchSlaMs: 30 * MIN,
  scheduledMatchSlaMs: 90 * MIN,
  asapWindowMs: 4 * HOUR,
  slotMinMs: 1 * HOUR,
  slotMaxMs: 4 * HOUR,
  slotStepMs: 30 * MIN,
  slotMaxAheadMs: 7 * 24 * HOUR,
  techNoShowGraceMs: 30 * MIN,
  waitGraceMs: 20 * MIN,
  maxVisitMs: 3 * HOUR,
  disclosureOpenLeadMs: 3 * HOUR,
  disclosureCloseAfterMs: 60 * MIN,
  l3RetentionMs: 30 * 24 * HOUR,
  codeMaxAttempts: 5,
  freeReleaseLeadMs: 2 * HOUR,
});
