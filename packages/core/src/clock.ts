/**
 * Clock abstractions for durable lifecycle services.
 *
 * Tests can inject a fixed clock while production uses wall time.
 */

export interface Clock {
  now(): Date;
  isoNow(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  isoNow(): string {
    return this.now().toISOString();
  }
}

