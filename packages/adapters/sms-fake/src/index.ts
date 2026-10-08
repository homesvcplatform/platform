// Adapter "sms-fake": implements identity's OtpSender port without sending anything (TE-02: no real SMS / DLT).
// Codes are held in memory only so automated tests (and a local developer) can complete the OTP flow; they are never
// logged. Refuses to load in production-shaped environments.
import { assertNonProduction } from '@hsp/kernel';
import type { OtpSender } from '@hsp/module-identity';

export interface FakeSms {
  readonly sender: OtpSender;
  /** The code delivered for a challenge (test / local use only). */
  codeFor(challengeId: string): string | undefined;
  readonly sentCount: () => number;
  /** Makes the next sends fail (provider outage simulation). */
  failNext(times: number): void;
}

export function createFakeSms(env: Readonly<Record<string, string | undefined>> = process.env): FakeSms {
  assertNonProduction(env);
  const codes = new Map<string, string>();
  let failures = 0;
  let sent = 0;
  return {
    sender: {
      async sendOtp(input) {
        if (failures > 0) {
          failures -= 1;
          return { accepted: false };
        }
        codes.set(input.challengeId, input.code);
        sent += 1;
        return { accepted: true };
      },
    },
    codeFor: (challengeId) => codes.get(challengeId),
    sentCount: () => sent,
    failNext(times) {
      failures = times;
    },
  };
}
