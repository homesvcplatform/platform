// @hsp/contracts: Zod DTOs per API surface (client-safe subset). Gate 3: authentication and session contracts
// (Phase 1 04 §3). Every request schema is strict: unknown fields are rejected (mass-assignment protection, 04 §1.2).
export * as auth from './auth.ts';
export * as admin from './admin.ts';
