// Process role entrypoint. Gate 1: validates configuration, enforces no-production guardrails,
// and serves an internal health endpoint. Business wiring arrives in later gates.
import { bootstrapRole } from '@hsp/kernel';

await bootstrapRole('webhook');
