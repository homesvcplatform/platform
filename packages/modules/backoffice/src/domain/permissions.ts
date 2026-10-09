// Admin permissions are defined in code (Phase 1 05 §5.3): an enumerated, versioned list, so they can't be invented
// through the UI. Role definitions (DB) may reference only these (wildcards cover a listed family).
export const PERMISSIONS_VERSION = 1;

export const ADMIN_PERMISSIONS = [
  // Support
  'jobs.read', 'support.book', 'support.callback', 'complaints.create', 'complaints.update', 'notifications.resend',
  'pii.reveal.phone', 'pii.reveal.address', 'support.capture_diagnosis', 'payments.refund.request', 'goodwill.issue',
  'disputes.investigate', 'support.record_approval',
  // Dispatch
  'dispatch.view_board', 'dispatch.assign', 'dispatch.reschedule', 'dispatch.override_presence', 'technicians.availability.edit_on_behalf',
  // Verification
  'verification.read_documents', 'verification.decide', 'technicians.onboarding.update', 'skills.verify',
  // Safety
  'safety.read', 'safety.ack', 'safety.hold', 'trust.sanction.propose', 'trust.suspend_pending_investigation', 'recordings.read',
  // Finance
  'payments.read', 'payments.refund.approve', 'finance.payout.prepare', 'finance.payout.approve', 'finance.payout_method.reveal',
  'finance.writeoff', 'reconciliation.run', 'reconciliation.resolve',
  // City manager approvals and reads
  'pricing.approve', 'zones.approve', 'trust.sanction.approve', 'service_rules.approve', 'presence_override.approve', 'analytics.read',
  // Pricing admin
  'pricing.edit', 'catalog.edit', 'service_rules.edit',
  // Auditor
  'audit.read', 'config.read', 'queues.read',
  // Security admin
  'security.grant', 'security.grant.approve', 'security.sessions.revoke', 'security.access_review',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** True when `entry` (a role_permissions row) is a listed permission or a wildcard covering at least one. */
export function isKnownPermissionEntry(entry: string): boolean {
  if (entry.endsWith('.*')) {
    const prefix = entry.slice(0, -1);
    return ADMIN_PERMISSIONS.some((p) => p.startsWith(prefix));
  }
  return (ADMIN_PERMISSIONS as readonly string[]).includes(entry);
}

/** 05 §2.5: SMS / TOTP / passwords are not allowed for admins. The IdP must assert a phishing-resistant method. */
export function isPhishingResistant(amr: unknown, acr: unknown): boolean {
  const methods = Array.isArray(amr) ? amr.filter((m): m is string => typeof m === 'string') : [];
  return methods.includes('hwk') || acr === 'phr' || acr === 'phrh';
}

export const ADMIN_SESSION = { idleMs: 30 * 60_000, absoluteMs: 10 * 3_600_000 } as const;
/** High-risk actions need a WebAuthn assertion at most this old (05 §2.5). */
export const ADMIN_STEP_UP_MS = 5 * 60_000;

/**
 * Operations a passkey step-up can authorise. The server decides what is bound: for a grant decision, the approval
 * request id and its stored payload hash. A step-up authorises exactly one use of exactly one operation.
 */
export const STEP_UP_OPERATIONS = ['security.grant.decide', 'backoffice.passkey.register'] as const;
export type StepUpOperation = (typeof STEP_UP_OPERATIONS)[number];
export const isStepUpOperation = (value: unknown): value is StepUpOperation =>
  typeof value === 'string' && (STEP_UP_OPERATIONS as readonly string[]).includes(value);

/**
 * The hand-written CBOR / WebAuthn verification (ADR-024 #2) has not passed an independent security review. Until it
 * does, passkey ceremonies run only in `local` and `test` (CI, software authenticators); deployed environments refuse
 * them (fail closed). Flip only with the recorded review outcome.
 */
export const WEBAUTHN_INDEPENDENT_REVIEW_PASSED = false;
export function passkeyCeremoniesAllowed(appEnv: string): boolean {
  return WEBAUTHN_INDEPENDENT_REVIEW_PASSED || appEnv === 'local' || appEnv === 'test';
}
/** The first passkey may be enrolled only shortly after a fresh IdP login. */
export const FIRST_PASSKEY_WINDOW_MS = 10 * 60_000;
export const APPROVAL_TTL_MS = 24 * 3_600_000;
export const ADMIN_COOKIE = '__Host-admin-sid';
