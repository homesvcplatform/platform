// @hsp/contracts: Zod DTOs per API surface (client-safe subset). Gate 3: authentication and session contracts
// (Phase 1 04 §3). Gate 4: public geo and catalog reads (04 §5–§6), admin change requests. Every request schema is
// strict: unknown fields are rejected (mass-assignment protection, 04 §1.2).
export * as auth from './auth.ts';
export * as admin from './admin.ts';
export * as geo from './geo.ts';
export * as catalog from './catalog.ts';
