// Injectable clock (Phase 1 03 §1: "The app clock is injectable for tests"). Production code asks a Clock for the
// time instead of calling Date.now(), so time-dependent rules (expiries, disclosure windows) are testable.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock fixed at `start` that tests can move forward explicitly. */
export class ManualClock implements Clock {
  #current: number;

  constructor(start: Date) {
    this.#current = start.getTime();
  }

  now(): Date {
    return new Date(this.#current);
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('ManualClock only moves forward');
    this.#current += ms;
  }
}
