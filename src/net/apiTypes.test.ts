import { describe, expect, it } from 'vitest';
import { toMeResponse } from './apiTypes';

describe('GET /api/me body (ACCOUNTS_SPEC_PHASE_2.md §6.5)', () => {
  it('is the status and nothing else: never the user id', () => {
    // A new key here is a deliberate API change (Phase 3 adds needsUsername
    // and username); update this snapshot with it, never around it.
    for (const status of ['active', 'suspended', 'deleting'] as const) {
      expect(Object.keys(toMeResponse(status))).toEqual(['status']);
      expect(toMeResponse(status)).toEqual({ status });
    }
  });
});
