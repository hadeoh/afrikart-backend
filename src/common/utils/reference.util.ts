import { randomBytes } from 'crypto';

// Generates a stable, time-sortable reference: prefix_<13-digit-ms>_<8-hex-chars>
export function generateRef(prefix: string): string {
  const ts = Date.now();
  const rand = randomBytes(4).toString('hex');
  return `${prefix}_${ts}_${rand}`;
}
