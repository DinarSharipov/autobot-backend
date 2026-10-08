import { describe, expect, it } from 'vitest';

import { assertIsolatedTestDatabase } from './test-database.js';

describe('assertIsolatedTestDatabase', () => {
  it('accepts an explicitly isolated test database', () => {
    expect(() =>
      assertIsolatedTestDatabase('postgresql://user:password@localhost:5432/autobot_test'),
    ).not.toThrow();
  });

  it('refuses to target development data', () => {
    expect(() =>
      assertIsolatedTestDatabase('postgresql://user:password@localhost:5432/autobot'),
    ).toThrow('does not end with _test');
  });
});
