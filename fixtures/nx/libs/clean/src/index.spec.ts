import { expect, it } from 'vitest';
import { sum } from './index';

it('sums', () => expect(sum([1, 2])).toBe(3));
