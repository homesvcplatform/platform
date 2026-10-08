// Port owned by identity (ADR-022): identity needs to send OTPs but must not import comms
// (comms depends on identity). The comms module implements this port; apps wire it.
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
