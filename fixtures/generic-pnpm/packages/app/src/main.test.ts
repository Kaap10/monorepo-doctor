import { expect, it } from 'vitest';
import { render } from './main';

it('renders', () => {
  expect(render()).toContain('Go');
});
