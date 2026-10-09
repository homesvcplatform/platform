// Phase 1 04 §5: public geo reads (anonymous, rate-limited). Requests are strict: unknown fields are rejected.
import { z } from 'zod';

/** A locale tag the client prefers; unknown or unoffered locales fall back to the city's primary locale. */
export const preferredLocale = z.string().regex(/^[a-z]{2}-[A-Z]{2}$/);

export const localitySearchQuery = z.strictObject({
  cityId: z.uuid(),
  q: z.string().min(1).max(60),
  locale: preferredLocale.optional(),
});

export const serviceabilityRequest = z.union([
  z.strictObject({ point: z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }) }),
  z.strictObject({ localityId: z.uuid() }),
]);
