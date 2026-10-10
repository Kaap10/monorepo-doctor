import { expect, it } from 'vitest';
import { apiUrl } from './config';

it('defaults', () => expect(apiUrl()).toBe('/api'));
