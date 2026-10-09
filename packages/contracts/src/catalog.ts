// Phase 1 04 §6: public service discovery (anonymous, cacheable, rate-limited). Requests are strict.
import { z } from 'zod';
import { preferredLocale } from './geo.ts';

export const categoriesQuery = z.strictObject({
  cityId: z.uuid(),
  locale: preferredLocale.optional(),
});

export const symptomsQuery = z.strictObject({
  cityId: z.uuid(),
  locale: preferredLocale.optional(),
});
