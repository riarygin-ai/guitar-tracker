// Auditable AI Advice v1.0 — canonical JSON + SHA-256 hash. Server-only
// (uses Node's crypto module). Deterministic: the same packet always
// produces the same hash regardless of source object-key insertion order,
// since every object's keys are sorted before serialization. The Advice
// Input Packet itself carries no volatile timestamp of its own (run_
// generated_at describes the SOURCE run, not "now"), so no field needs
// stripping before hashing — the packet as constructed IS the canonical
// input.

import { createHash } from 'crypto';

/** Recursively sorts every object's keys (arrays keep their existing
 *  order — order is semantically meaningful there, e.g. candidate_
 *  segments/selected_findings ordering). Mirrors the stableStringify
 *  helper convention already used by this project's test scripts. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {} as Record<string, unknown>);
  }
  return value;
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** The one function callers should use — canonicalizes then hashes in one
 *  step, so no call site can accidentally hash a non-canonicalized form. */
export function hashCanonicalInputPacket(packet: unknown): string {
  return sha256Hex(canonicalJsonStringify(packet));
}
