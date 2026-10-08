// @hsp/security: keyed hashing and blind indexes, one-time codes and opaque tokens, Argon2id, ES256 JWTs,
// field envelope encryption (SR-06 / SR-07), request trust (signed client IP, CSRF) and WebAuthn verification.
// `createFieldCrypto` may only be imported by the disclosure / reveal paths listed in eslint.config.js (SR-06).
export { ARGON2_DEFAULTS, hashSecret, needsRehash, verifySecret } from './argon2.ts';
export type { Argon2Params } from './argon2.ts';
export { numericCode, opaqueToken, otpCodeHmac, tokenHash } from './codes.ts';
export {
  canonicalContext, createDekCache, createFieldCrypto, DATA_CLASSES, FieldDecryptionError, KmsAccessDeniedError, MAX_DEK_CACHE_MS,
  SubjectKeyDestroyedError,
} from './field-crypto.ts';
export type { DataClass, DekCache, EncryptionContext, FieldCrypto, KeyManagementPort, StoredSubjectKey, SubjectKeyStore } from './field-crypto.ts';
export { assertKey, blindIndex, constantTimeEqual, hmacSha256, KeyMaterialError, logRef, MIN_KEY_BYTES, sha256 } from './hashing.ts';
export { JwtError, localEs256Signer, signJwt, verifyJwt } from './jwt.ts';
export type { JwtClaims, JwtErrorCode, JwtSigner, VerifyOptions } from './jwt.ts';
export { createRateLimiter, MemoryRateLimitStore, RATE_RULES } from './rate-limit.ts';
export type { RateLimitCheck, RateLimiter, RateLimitRule, RateLimitStore } from './rate-limit.ts';
export { CLIENT_IP_HEADER, csrfToken, resolveClientIp, signClientIp, verifyClientIpHeader, verifyCsrfToken } from './request-trust.ts';
export type { InboundConnection } from './request-trust.ts';
export { decodeCbor, verifyAssertion, verifyRegistration, WebAuthnError } from './webauthn.ts';
export type { AssertionInput, RegisteredCredential, RegistrationInput } from './webauthn.ts';
