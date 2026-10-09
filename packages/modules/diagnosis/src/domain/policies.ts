// diagnosis authorization policies (Phase 1 05 §11 rows "Create/submit diagnosis" (TEC-APP O, SUP-L1 S capture on a
// bridged call, SUP-L2 S), "Approve/reject quote" (CUS O own channel; SUP-L2 S,M recorded call), "Edit approved quote"
// (nobody, ever); 05 §4.2 quote version row: job owner view / approve / reject, assigned technician view only).
// Object-level denials return 404 so another customer's quote or another technician's visit isn't confirmed to exist.
// Nobody - customer, technician, ops or super-admin - has a policy to edit a quote version or its items (INV-05).
import { ALLOW, deny, hasPermission, type Actor, type PolicyRegistry } from '@hsp/policy';

export interface QuoteOwnerResource {
  readonly ownerUserId: string | null;
}

export interface DiagnosisAssigneeResource {
  /** The actor is the visit's ACTIVE assignee (write) or has / had an assignment on it (read). */
  readonly isAssignee: boolean;
}

export interface DiagnosisCityResource {
  /** undefined = "in any city" (pre-check before the target is known). */
  readonly cityId: string | undefined;
}

const customerSession = (a: Actor) => a.kind === 'CUSTOMER' && a.id !== undefined && a.sessionId !== undefined && a.surface === 'CUSTOMER_WEB';
const technicianApp = (a: Actor) => a.kind === 'TECHNICIAN' && a.id !== undefined && a.sessionId !== undefined && a.surface === 'TECHNICIAN_APP';
const scoped = (a: Actor, permission: string, r: DiagnosisCityResource) =>
  a.kind === 'ADMIN' && (r.cityId === undefined ? hasPermission(a, permission) : hasPermission(a, permission, r.cityId));

export function registerDiagnosisPolicies(registry: PolicyRegistry): void {
  // Technician app: draft, preview, submit only as the visit's ACTIVE assignee; view the quote of an own visit.
  registry.define<DiagnosisAssigneeResource>('diagnosis.diagnosis.write', (a, r) => (technicianApp(a) && r.isAssignee ? ALLOW : deny('NOT_ASSIGNEE', 404)));
  registry.define<DiagnosisAssigneeResource>('diagnosis.quote.read_technician', (a, r) => (technicianApp(a) && r.isAssignee ? ALLOW : deny('NOT_ASSIGNEE', 404)));
  // Customer: own job only, from the own session (INV-08). Technicians, agents and ops can't decide (no policy grants it).
  registry.define<QuoteOwnerResource>('diagnosis.quote.read_customer', (a, r) => (customerSession(a) && r.ownerUserId === a.id ? ALLOW : deny('NOT_OWNER', 404)));
  registry.define<QuoteOwnerResource>('diagnosis.quote.decide', (a, r) => (customerSession(a) && r.ownerUserId === a.id ? ALLOW : deny('NOT_OWNER', 404)));
  // Signed link (SR-05): the link token + the OTP sent to the job's registered number are the credentials.
  registry.define('diagnosis.link.use', () => ALLOW);
  // Ops-desk capture for a basic-phone technician on a bridged call (support.capture_diagnosis, city-scoped).
  registry.define<DiagnosisCityResource>('diagnosis.ops_capture', (a, r) => (scoped(a, 'support.capture_diagnosis', r) ? ALLOW : deny('NO_CAPABILITY')));
  // Ops-recorded approval (accessibility fallback, flag-off, D-11): recorder and verifier both hold support.record_approval.
  registry.define<DiagnosisCityResource>('diagnosis.quote.record_decision', (a, r) => (scoped(a, 'support.record_approval', r) ? ALLOW : deny('NO_CAPABILITY')));
}
