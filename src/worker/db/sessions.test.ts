// The session suite on the in-memory SQLite adapter. The same suite runs on
// real local D1 in d1.workers.test.ts.

import { sessionsSuite } from './sessions.suite';
import { recording } from './suiteDb';
import { createTestDb } from './testDb';

sessionsSuite(async () => recording(createTestDb()));
