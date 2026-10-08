// Phase 1 04 §3: customer / technician / field-agent authentication and sessions.
import { z } from 'zod';

/** Indian mobile numbers (+91, leading 6-9). Non-production deployments accept only the reserved test range instead. */
export const indianMobile = z.string().regex(/^\+91[6-9]\d{9}$/);
/** Reserved fake range used by synthetic fixtures (+91 0000 0xxxxx): a leading 0 after +91 is never a real mobile. */
export const reservedTestPhone = z.string().regex(/^\+9100000\d{5}$/);

export const surface = z.enum(['CUSTOMER_WEB', 'TECHNICIAN_APP', 'AGENT_WEB']);
export const locale = z.enum(['te-IN', 'en-IN']);

export const otpRequest = z.strictObject({
  phone: z.string().min(1).max(20),
  purpose: z.literal('LOGIN'),
  locale,
  channel: z.enum(['SMS', 'WHATSAPP', 'VOICE']).default('SMS'),
  integrityToken: z.string().min(1).max(4096).optional(),
});
export type OtpRequest = z.infer<typeof otpRequest>;

export const otpRequestAccepted = z.strictObject({
  challengeId: z.uuid(),
  channel: z.enum(['SMS', 'WHATSAPP', 'VOICE']),
  resendAfterSec: z.number().int(),
  expiresInSec: z.number().int(),
});

export const otpVerify = z.strictObject({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
  surface,
  device: z.strictObject({
    platform: z.enum(['ANDROID_APP', 'WEB']),
    appVersion: z.string().max(40).optional(),
    deviceId: z.uuid().optional(),
    integrityToken: z.string().min(1).max(4096).optional(),
  }),
});
export type OtpVerify = z.infer<typeof otpVerify>;

export const tokenRefresh = z.strictObject({
  refreshToken: z.string().min(40).max(200),
  deviceId: z.uuid(),
});

export const stepUpComplete = z.strictObject({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
});

export const sessionSummary = z.strictObject({
  id: z.uuid(),
  surface,
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  current: z.boolean(),
});
