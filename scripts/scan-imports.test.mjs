import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanMd = fs.readFileSync(path.join(root, 'skills', 'monorepo-doctor', 'references', 'scan.md'), 'utf8');

const stripCommentsMatch = scanMd.match(/const stripComments = [^;]+;/);
const allNamedMatch = scanMd.match(/function allNamedSpecifiersAreTypeOnly\([\s\S]*?\n\}/);

assert.ok(stripCommentsMatch, 'stripComments should be defined in scan.md');
assert.ok(allNamedMatch, 'allNamedSpecifiersAreTypeOnly should be defined in scan.md');

const allNamedSpecifiersAreTypeOnly = new Function(`${stripCommentsMatch[0]}; return (${allNamedMatch[0]});`)();

test('allNamedSpecifiersAreTypeOnly: returns true when all specifiers inside braces are type-only', () => {
  assert.equal(allNamedSpecifiersAreTypeOnly('{ type A, type B } from '), true);
  assert.equal(allNamedSpecifiersAreTypeOnly('{\n  type A,\n  type B as C\n} from '), true);
  assert.equal(allNamedSpecifiersAreTypeOnly('{ type A } from '), true);
});

test('allNamedSpecifiersAreTypeOnly: returns false when default import precedes braces', () => {
  assert.equal(allNamedSpecifiersAreTypeOnly('Button, { type ButtonProps } from '), false);
  assert.equal(allNamedSpecifiersAreTypeOnly('React, { type FC, type ReactNode } from '), false);
  assert.equal(allNamedSpecifiersAreTypeOnly('apiClient, { type RequestConfig } from '), false);
});

test('allNamedSpecifiersAreTypeOnly: returns false when comments precede braces with default import', () => {
  assert.equal(allNamedSpecifiersAreTypeOnly('Button, /* props */ { type ButtonProps } from '), false);
  assert.equal(allNamedSpecifiersAreTypeOnly('Button, // inline comment\n { type ButtonProps } from '), false);
});

test('allNamedSpecifiersAreTypeOnly: returns false when mixed value and type specifiers exist inside braces', () => {
  assert.equal(allNamedSpecifiersAreTypeOnly('{ A, type B } from '), false);
  assert.equal(allNamedSpecifiersAreTypeOnly('{ A as B, type C } from '), false);
});

test('allNamedSpecifiersAreTypeOnly: returns false when no braces exist', () => {
  assert.equal(allNamedSpecifiersAreTypeOnly('* as utils from '), false);
  assert.equal(allNamedSpecifiersAreTypeOnly('DefaultExport from '), false);
  assert.equal(allNamedSpecifiersAreTypeOnly(''), false);
});

test('scanner import logic retains default import when mixed with type specifiers', () => {
  const importRe = /^[ \t]*(import|export)\s+(type\s+)?((?:(?!\n[ \t]*(?:import|export)\b)[\w$*{},\s]|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*?\bfrom\s*)?['"]([^'"\n]+)['"]/gm;
  const line = "import Button, { type ButtonProps } from '@acme/ui';";
  const m = [...line.matchAll(importRe)][0];

  assert.ok(m, 'import line should match importRe');
  assert.equal(m[2], undefined, 'statement should not be marked import type');
  assert.equal(allNamedSpecifiersAreTypeOnly(m[3]), false, 'should not be dropped as type-only');
  assert.equal(m[4], '@acme/ui', 'target specifier should be extracted');
});
