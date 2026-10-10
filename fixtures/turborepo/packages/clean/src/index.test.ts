import { expect, it } from 'vitest';
import { greet } from './index';

it('greets', () => expect(greet('x')).toBe('hello x'));
