// Authorization-matrix test generator (Phase 1 13 §4, Gate 3 exit criterion). Expands every cell of the V1 matrix
// (05 §11) into a test case. Capabilities with implemented endpoints are checked cell by cell (allowed cells must
// allow, ❌ cells must deny). Every other capability, and cells whose mechanism belongs to a later gate, must be
// denied by default (no policy registered → default deny), and are listed as pending with the reason.
import { AUTHZ_MATRIX, cellAllows, MATRIX_COLUMNS, type MatrixColumn } from '@hsp/policy';

export interface MatrixCase {
  readonly capability: string;
  readonly column: MatrixColumn;
  readonly cell: string;
  /** "implemented": the policy must return exactly cellAllows(cell). "pending": it must deny (default deny). */
  readonly mode: 'implemented' | 'pending';
  readonly expectAllow: boolean;
  readonly pendingReason?: string;
}

export interface ImplementedCapability {
  readonly capability: string;
  readonly action: string;
  /** Columns whose mechanism is out of this gate's scope (e.g. break-glass), with the reason. */
  readonly pendingColumns?: Readonly<Partial<Record<MatrixColumn, string>>>;
}

export function generateMatrixCases(implemented: readonly ImplementedCapability[]): MatrixCase[] {
  const byCapability = new Map(implemented.map((i) => [i.capability, i]));
  for (const i of implemented) {
    if (!AUTHZ_MATRIX.some((r) => r.capability === i.capability)) throw new Error(`unknown matrix capability "${i.capability}"`);
  }
  const cases: MatrixCase[] = [];
  for (const row of AUTHZ_MATRIX) {
    const impl = byCapability.get(row.capability);
    for (const column of MATRIX_COLUMNS) {
      const cell = row.cells[column];
      const pendingReason = impl ? impl.pendingColumns?.[column] : 'capability not implemented yet (later gate)';
      cases.push(pendingReason !== undefined
        ? { capability: row.capability, column, cell, mode: 'pending', expectAllow: false, pendingReason }
        : { capability: row.capability, column, cell, mode: 'implemented', expectAllow: cellAllows(cell) });
    }
  }
  return cases;
}

/** Stable policy-action name for a capability that has no implementation yet (used to prove default deny). */
export function placeholderAction(capability: string): string {
  return `matrix.${capability.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}
