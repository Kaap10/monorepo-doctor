import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from './verify-fixture.mjs';

const finding = (id, severity, pkg) => ({
  id, check: id.split('/')[0], severity, title: 't', evidence: 'e', fix: 'f',
  location: pkg ? { file: 'x', package: pkg } : { file: 'x' },
});
const report = (findings) => {
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) summary[f.severity]++;
  return { version: 1, workspace: {}, summary, checks: [], findings };
};
const expected = {
  fixture: 'demo',
  cleanPackages: ['@x/clean'],
  mustFind: [{ id: 'circular-deps/package-cycle' }, { id: 'boundaries/deep-import', package: '@x/app' }],
};

test('passes when every expected finding is present', () => {
  const r = verify(report([finding('circular-deps/package-cycle', 'high'), finding('boundaries/deep-import', 'medium', '@x/app')]), expected);
  assert.equal(r.ok, true);
});

test('reports missing ids', () => {
  const r = verify(report([finding('circular-deps/package-cycle', 'high')]), expected);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map((m) => m.id), ['boundaries/deep-import']);
});

test('package must match when expected specifies one', () => {
  const r = verify(report([finding('circular-deps/package-cycle', 'high'), finding('boundaries/deep-import', 'medium', '@x/other')]), expected);
  assert.deepEqual(r.missing.map((m) => m.id), ['boundaries/deep-import']);
});

test('medium+ findings on clean packages fail; low is allowed', () => {
  const base = [finding('circular-deps/package-cycle', 'high'), finding('boundaries/deep-import', 'medium', '@x/app')];
  assert.equal(verify(report([...base, finding('boundaries/oversized-package', 'low', '@x/clean')]), expected).ok, true);
  const r = verify(report([...base, finding('caching/undeclared-env', 'medium', '@x/clean')]), expected);
  assert.equal(r.cleanViolations.length, 1);
  assert.equal(r.ok, false);
});

test('schema errors: missing keys, bad severity, summary mismatch', () => {
  const bad = report([{ id: 'a/b', severity: 'urgent' }]);
  bad.summary.high = 5;
  delete bad.checks;
  const r = verify(bad, { ...expected, mustFind: [] });
  assert.ok(r.schemaErrors.some((e) => e.includes('"checks"')));
  assert.ok(r.schemaErrors.some((e) => e.includes('invalid severity')));
  assert.ok(r.schemaErrors.some((e) => e.includes('missing "fix"')));
  assert.ok(r.schemaErrors.some((e) => e.includes('summary')));
});
