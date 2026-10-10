import { expect, it } from 'vitest';
import { label } from './format';

it('uppercases', () => {
  expect(label('ok')).toContain('OK');
});
