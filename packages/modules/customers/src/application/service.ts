// Read-only address interface for Gate 5 (ADR-026 #2). Booking checks that an address belongs to the customer, is live
// and is serviceable, and freezes a snapshot of its ciphertexts (nothing is decrypted at booking). Only the jobs
// disclosure service has a snapshot opened, at L2 (INV-17); that is the single decryption path here (SR-06).
// Address create / edit APIs belong to Gate 8.
import type pg from 'pg';
import type { Clock } from '@hsp/kernel';
import { createFieldCrypto, type DekCache, type KeyManagementPort, type SubjectKeyStore } from '@hsp/security';
import { SQL } from '../infrastructure/sql.ts';

/** Serviceability and zone of a locality (implemented by geo, wired by the app). */
export interface LocalityDirectory {
  locality(localityId: string): Promise<{ readonly cityId: string; readonly zoneId: string; readonly serviceable: boolean } | null>;
}

export interface CustomersDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  readonly kms: KeyManagementPort;
  readonly dekCache: DekCache;
  /** identity's subject-key store (wrapped data keys stay owned by identity). */
  readonly keyStore: (q: pg.Pool | pg.ClientBase) => SubjectKeyStore;
  readonly localities: LocalityDirectory;
}

export interface BookingAddress {
  readonly addressId: string;
  readonly cityId: string;
  readonly zoneId: string;
  readonly localityId: string;
  readonly serviceable: boolean;
  /** Frozen ciphertexts of the address (opened only through `openAddressSnapshot`). */
  readonly snapshot: Buffer;
}

export interface OpenedAddress {
  readonly line1: string;
  readonly line2: string | null;
  readonly landmark: string;
  readonly accessNotes: string | null;
}

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNAPSHOT_VERSION = 1;

const b64 = (v: unknown) => (Buffer.isBuffer(v) ? v.toString('base64') : null);

export class CustomersService {
  readonly #d: CustomersDeps;

  constructor(deps: CustomersDeps) {
    this.#d = deps;
  }

  /** The address if it belongs to the customer and isn't deleted (else null), with its serviceability and a snapshot. */
  async addressForBooking(customerUserId: string, addressId: string): Promise<BookingAddress | null> {
    if (!UUID.test(customerUserId) || !UUID.test(addressId)) return null;
    const r = (await this.#d.pool.query(SQL.ownedAddress, [addressId, customerUserId])).rows[0] as Row | undefined;
    if (!r) return null;
    const loc = await this.#d.localities.locality(r['locality_id'] as string);
    const snapshot = Buffer.from(JSON.stringify({ v: SNAPSHOT_VERSION, line1: b64(r['line1_enc']), line2: b64(r['line2_enc']),
      landmark: b64(r['landmark_enc']), accessNotes: b64(r['access_notes_enc']) }), 'utf8');
    return { addressId, cityId: r['city_id'] as string, localityId: r['locality_id'] as string, zoneId: loc?.zoneId ?? '',
      serviceable: loc !== null && loc.serviceable && loc.cityId === r['city_id'], snapshot };
  }

  /** Opens a booking snapshot. Callers (jobs disclosure, L2 only) log the disclosure event themselves. */
  async openAddressSnapshot(customerUserId: string, snapshot: Buffer): Promise<OpenedAddress> {
    const parsed = JSON.parse(snapshot.toString('utf8')) as Record<string, unknown>;
    if (parsed['v'] !== SNAPSHOT_VERSION) throw new Error('unknown address snapshot version');
    const crypto = createFieldCrypto({ kms: this.#d.kms, store: this.#d.keyStore(this.#d.pool), clock: this.#d.clock, cache: this.#d.dekCache });
    const ctx = { subjectId: customerUserId, dataClass: 'pii-address' as const };
    const open = async (key: string) => {
      const v = parsed[key];
      return typeof v === 'string' ? crypto.open(ctx, Buffer.from(v, 'base64')) : null;
    };
    const line1 = await open('line1');
    const landmark = await open('landmark');
    if (line1 === null || landmark === null) throw new Error('address snapshot is incomplete');
    return { line1, line2: await open('line2'), landmark, accessNotes: await open('accessNotes') };
  }
}
