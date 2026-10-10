import { describe, expect, it } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('renders the label', () => {
    expect(Button('Save')).toBe('<button>Save</button>');
  });
});
