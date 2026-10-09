// Authorization matrix V1, generated from docs/phase-1/05-auth-authorization.md §11 (do not edit by hand: regenerate
// if the source table changes; a unit test compares the two). Legend: ✅ allowed · O own/relationship-scoped ·
// S city/zone-scoped · M maker · C checker · R reason + audited reveal · L limited fields · ❌ denied.

export const MATRIX_COLUMNS = ["CUS", "TEC-APP", "TEC-IVR", "AGT", "SUP-L1", "SUP-L2", "DISP", "VER", "SAF", "FIN", "CM", "PRC", "AUD", "SEC", "SUPER (BG)"] as const;
export type MatrixColumn = (typeof MATRIX_COLUMNS)[number];

export interface MatrixRow {
  readonly capability: string;
  readonly cells: Readonly<Record<MatrixColumn, string>>;
}

export const AUTHZ_MATRIX: readonly MatrixRow[] = [
  { capability: "Create booking", cells: { "CUS": "O", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "S", "SUP-L2": "S", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "View job", cells: { "CUS": "O", "TEC-APP": "O,L", "TEC-IVR": "O,L", "AGT": "O,L (linked)", "SUP-L1": "S,L", "SUP-L2": "S", "DISP": "S", "VER": "❌", "SAF": "S", "FIN": "S,L", "CM": "S", "PRC": "❌", "AUD": "S,L", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "Cancel job", cells: { "CUS": "O", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "S", "SUP-L2": "S", "DISP": "S", "VER": "❌", "SAF": "S", "FIN": "❌", "CM": "S", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "See exact address", cells: { "CUS": "O", "TEC-APP": "O (L2 window)", "TEC-IVR": "O (PIN, L2)", "AGT": "❌ (assist mode only)", "SUP-L1": "R", "SUP-L2": "R", "DISP": "R", "VER": "❌", "SAF": "R", "FIN": "❌", "CM": "R", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "See customer phone", cells: { "CUS": "O (own)", "TEC-APP": "❌ (masked call)", "TEC-IVR": "❌ (bridge)", "AGT": "❌", "SUP-L1": "R", "SUP-L2": "R", "DISP": "R", "VER": "❌", "SAF": "R", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "Accept/decline offer", cells: { "CUS": "❌", "TEC-APP": "O", "TEC-IVR": "O", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Manual assignment", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "S", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "S", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "Depart/arrive (with code)", cells: { "CUS": "❌", "TEC-APP": "O", "TEC-IVR": "O (PIN)", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Presence override", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "S,M", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "C", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "Create/submit diagnosis", cells: { "CUS": "❌", "TEC-APP": "O", "TEC-IVR": "via ops", "AGT": "❌", "SUP-L1": "S (capture, bridged call)", "SUP-L2": "S", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Approve/reject quote", cells: { "CUS": "O (own channel)", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "S,M (recorded call)", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Edit approved quote", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌ (never)" } },
  { capability: "Complete repair (code)", cells: { "CUS": "❌", "TEC-APP": "O", "TEC-IVR": "O (PIN)", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Record cash", cells: { "CUS": "❌", "TEC-APP": "O", "TEC-IVR": "O (PIN)", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Pay bill", cells: { "CUS": "O", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌ (send link)", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Request refund", cells: { "CUS": "via complaint", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "S (≤thr) / M", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "M", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Approve refund > threshold", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "C", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "Prepare payout batch", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "M", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Approve payout batch", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "C (not own)", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Add payout method", cells: { "CUS": "❌", "TEC-APP": "O (step-up)", "TEC-IVR": "❌", "AGT": "M (assisted)", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "C", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Reveal payout details", cells: { "CUS": "❌", "TEC-APP": "O (masked)", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "R", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "Upload KYC docs", cells: { "CUS": "❌", "TEC-APP": "O", "TEC-IVR": "via agent", "AGT": "O (linked, pre-submit)", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "✅ S", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Verification decision", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "S", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Edit skills/areas", cells: { "CUS": "❌", "TEC-APP": "request", "TEC-IVR": "request", "AGT": "M (linked)", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "S", "VER": "S,C", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Rate", cells: { "CUS": "O", "TEC-APP": "O", "TEC-IVR": "via IVR (V1.1)", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Raise complaint", cells: { "CUS": "O", "TEC-APP": "O", "TEC-IVR": "via IVR/agent", "AGT": "on behalf (linked)", "SUP-L1": "S", "SUP-L2": "S", "DISP": "❌", "VER": "❌", "SAF": "S", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Decide dispute", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "S", "DISP": "❌", "VER": "❌", "SAF": "S (conduct)", "FIN": "S (payment)", "CM": "S (appeal)", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Propose sanction", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "S", "DISP": "❌", "VER": "❌", "SAF": "S", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Approve suspension/deactivation", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "≤72 h interim", "FIN": "❌", "CM": "C", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "SOS raise", cells: { "CUS": "O", "TEC-APP": "O", "TEC-IVR": "O (any caller)", "AGT": "O", "SUP-L1": "✅", "SUP-L2": "✅", "DISP": "✅", "VER": "✅", "SAF": "✅", "FIN": "✅", "CM": "✅", "PRC": "✅", "AUD": "✅", "SEC": "✅", "SUPER (BG)": "✅" } },
  { capability: "SOS handle", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "ack/escalate", "SUP-L2": "ack/escalate", "DISP": "❌", "VER": "❌", "SAF": "✅", "FIN": "❌", "CM": "✅", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "Listen to recordings", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "R (complaint-linked)", "DISP": "❌", "VER": "❌", "SAF": "R", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "✅" } },
  { capability: "Edit pricing/rules", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "C", "PRC": "M", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Edit matching config", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "M", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "C", "PRC": "❌", "AUD": "❌", "SEC": "❌", "SUPER (BG)": "❌" } },
  { capability: "Read audit logs", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "S (own city ops)", "PRC": "❌", "AUD": "✅", "SEC": "✅", "SUPER (BG)": "✅" } },
  { capability: "Grant roles", cells: { "CUS": "❌", "TEC-APP": "❌", "TEC-IVR": "❌", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "M / C (not own)", "SUPER (BG)": "✅" } },
  { capability: "Revoke sessions", cells: { "CUS": "own", "TEC-APP": "own", "TEC-IVR": "❌", "AGT": "own", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "❌", "CM": "❌", "PRC": "❌", "AUD": "❌", "SEC": "✅", "SUPER (BG)": "✅" } },
  { capability: "Export data (bulk)", cells: { "CUS": "own DSR", "TEC-APP": "own DSR", "TEC-IVR": "via agent", "AGT": "❌", "SUP-L1": "❌", "SUP-L2": "❌", "DISP": "❌", "VER": "❌", "SAF": "❌", "FIN": "M (pseudonymised)", "CM": "C", "PRC": "❌", "AUD": "✅ (audit only)", "SEC": "❌", "SUPER (BG)": "✅" } },
];

/** A cell grants something (possibly conditional on scope, ownership, reason or maker-checker) unless it is ❌. */
export function cellAllows(cell: string): boolean {
  return !cell.startsWith('❌');
}
