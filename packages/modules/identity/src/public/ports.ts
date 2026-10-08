// Ports owned by identity (ADR-022). Implementations live in other modules or adapters and are wired by apps.
import type { Surface } from '../domain/rules.ts';

/** Identity needs to send OTPs but must not import comms (comms depends on identity). Comms implements this port. */
export interface OtpSender {
  sendOtp(input: {
    readonly challengeId: string;
    readonly channel: 'SMS' | 'WHATSAPP' | 'VOICE';
    /** One-time code to deliver. Must never be logged, traced or persisted in plaintext (Phase 1 05 §4). */
    readonly code: string;
    /** Recipient is resolved by comms from the user id; identity never passes raw phone numbers around. */
    readonly userId: string;
  }): Promise<{ readonly accepted: boolean }>;
}

/**
 * Whether a user may open a session on a surface (05 §6: the technician app is gated by an active technician
 * profile; the agent web by an active field-agent link). Implemented by workforce; customers are always eligible.
 */
export interface SurfaceEligibility {
  isEligible(userId: string, surface: Surface): Promise<boolean>;
}

/** Bot check for the OTP global breaker (04 §3: Turnstile on web, Play Integrity on the app). Fake adapter in Phase 2. */
export interface BotVerifier {
  verify(token: string): Promise<boolean>;
}
