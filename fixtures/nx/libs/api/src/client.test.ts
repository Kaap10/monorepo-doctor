import { expect, it } from 'vitest';
import { baseUrl } from './client';

it('has a default', () => {
  expect(baseUrl()).toMatch(/^http/);
});
