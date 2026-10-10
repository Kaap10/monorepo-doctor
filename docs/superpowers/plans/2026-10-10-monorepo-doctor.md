# monorepo-doctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a read-only agent skill (`monorepo-doctor`) that audits JS/TS monorepos (generic workspaces, Nx, Turborepo) for five classes of problems and writes a Markdown + JSON report.

**Architecture:** A single SKILL.md drives a 4-phase workflow (detect → scan → checks → report). Each phase/check lives in its own `references/*.md` file, loaded on demand. Deterministic work (inventory, source scan, cycle detection, report rendering) is done by Node snippets embedded in the reference files that the agent writes to `$TMPDIR/monorepo-doctor/` and runs. Judgment-based rules are prose. External CLIs (`publint`, `knip`, `npm pack`) run through `npx --yes`; `nx`/`turbo` only when installed locally.

**Tech Stack:** Markdown (skill), Node.js ≥ 22 (snippets use `fs.globSync`), `node:test` for repo tooling tests. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-monorepo-doctor-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `package.json` | Dev-only scripts: `test`, `check` |
| `scripts/verify-fixture.mjs` (+ `.test.mjs`) | Compare a generated report against `fixtures/expected/<name>.json` |
| `scripts/check-skill.mjs` (+ `.test.mjs`) | Lint the skill: frontmatter, reference links, finding-id catalog coverage |
| `fixtures/generic-pnpm/**` | pnpm workspace seeded with issues for all five checks |
| `fixtures/nx/**` | npm workspace + Nx seeded with Nx-specific issues |
| `fixtures/turborepo/**` | pnpm workspace + Turborepo seeded with Turbo-specific issues |
| `fixtures/expected/*.json` | Finding ids each fixture must produce + clean packages |
| `skills/monorepo-doctor/SKILL.md` | Trigger + workflow + rules |
| `skills/monorepo-doctor/references/detection.md` | Phase 1: inventory snippet → `workspace.json` |
| `skills/monorepo-doctor/references/scan.md` | Phase 2: source scan snippet → `scan.json` |
| `skills/monorepo-doctor/references/boundaries.md` | Check 1 |
| `skills/monorepo-doctor/references/circular-deps.md` | Check 2 (+ cycles snippet) |
| `skills/monorepo-doctor/references/caching.md` | Check 3 |
| `skills/monorepo-doctor/references/ci-coverage.md` | Check 4 |
| `skills/monorepo-doctor/references/prod-leakage.md` | Check 5 |
| `skills/monorepo-doctor/references/report-format.md` | Phase 4: findings contract, severity rubric, render snippet |
| `README.md`, `LICENSE` | Docs, MIT |

## Finding-id catalog (single source of truth; every reference must use these exact ids)

| id | default severity |
|---|---|
| `boundaries/oversized-package` | low |
| `boundaries/deep-import` | medium |
| `boundaries/unlisted-dependency` | medium |
| `boundaries/unused-dependency` | low |
| `boundaries/nx-missing-module-boundaries-rule` | medium |
| `boundaries/nx-permissive-module-boundaries` | low |
| `boundaries/nx-untagged-project` | low |
| `boundaries/turbo-boundaries-violation` | medium |
| `circular-deps/package-cycle` | high |
| `circular-deps/file-cycle` | medium |
| `caching/missing-outputs` | high |
| `caching/build-inputs-include-tests` | medium |
| `caching/undeclared-env` | medium |
| `caching/turbo-cache-disabled` | medium |
| `caching/unstable-hash` | high |
| `caching/volatile-input` | high |
| `caching/uncached-root-script` | low |
| `ci-coverage/undeclared-workspace-dependency` | critical (medium under Nx) |
| `ci-coverage/missing-test-script` | high |
| `ci-coverage/tests-not-run-in-ci` | high |
| `ci-coverage/shallow-checkout-affected` | high |
| `ci-coverage/nx-affected-base-missing` | high |
| `ci-coverage/nx-test-inputs-ignore-deps` | high |
| `ci-coverage/turbo-test-missing-dependson` | high |
| `prod-leakage/test-files-in-package` | critical |
| `prod-leakage/test-files-in-build-output` | critical |
| `prod-leakage/build-tsconfig-includes-tests` | high |
| `prod-leakage/test-lib-in-dependencies` | high (medium if private) |
| `prod-leakage/publint-issue` | mapped from publint level |

---

### Task 1: Repo scaffold + fixture verifier (TDD)

**Files:**
- Create: `package.json`, `.gitignore`, `LICENSE`
- Create: `scripts/verify-fixture.mjs`
- Test: `scripts/verify-fixture.test.mjs`

- [ ] **Step 1: Scaffold**

`package.json`:
```json
{
  "name": "monorepo-doctor",
  "private": true,
  "type": "module",
  "description": "Agent skill that audits JS/TS monorepos (Nx, Turborepo, workspaces) for boundary, cycle, caching, CI-coverage and prod-leakage problems.",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test scripts/*.test.mjs",
    "check": "node scripts/check-skill.mjs"
  }
}
```

`.gitignore`:
```
node_modules/
monorepo-doctor-report.json
monorepo-doctor-report.md
```

`LICENSE`: standard MIT text, `Copyright (c) 2026 Santosh Yadav`.

- [ ] **Step 2: Write the failing test** — `scripts/verify-fixture.test.mjs`

```js
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../scripts/verify-fixture.mjs'`

- [ ] **Step 4: Implement** — `scripts/verify-fixture.mjs`

```js
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const REPORT_KEYS = ['version', 'workspace', 'summary', 'checks', 'findings'];
const FINDING_KEYS = ['id', 'check', 'severity', 'title', 'location', 'evidence', 'fix'];

export function verify(report, expected) {
  const findings = report.findings ?? [];
  const schemaErrors = [];
  for (const k of REPORT_KEYS) if (!(k in report)) schemaErrors.push(`report missing "${k}"`);
  for (const f of findings) {
    for (const k of FINDING_KEYS) if (!(k in f)) schemaErrors.push(`finding ${f.id ?? '?'} missing "${k}"`);
    if (!(f.severity in RANK)) schemaErrors.push(`finding ${f.id ?? '?'} has invalid severity "${f.severity}"`);
  }
  if (report.summary) {
    for (const s of Object.keys(RANK)) {
      const n = findings.filter((f) => f.severity === s).length;
      if (report.summary[s] !== n) schemaErrors.push(`summary.${s} is ${report.summary[s]} but ${n} finding(s) have that severity`);
    }
  }
  const missing = expected.mustFind.filter(
    (e) => !findings.some((f) => f.id === e.id && (e.package === undefined || f.location?.package === e.package)),
  );
  const cleanViolations = findings.filter(
    (f) => expected.cleanPackages.includes(f.location?.package) && RANK[f.severity] >= RANK.medium,
  );
  return { missing, cleanViolations, schemaErrors, ok: !missing.length && !cleanViolations.length && !schemaErrors.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [reportPath, expectedPath] = process.argv.slice(2);
  if (!reportPath || !expectedPath) {
    console.error('usage: node scripts/verify-fixture.mjs <report.json> <expected.json>');
    process.exit(2);
  }
  const r = verify(JSON.parse(fs.readFileSync(reportPath, 'utf8')), JSON.parse(fs.readFileSync(expectedPath, 'utf8')));
  for (const e of r.schemaErrors) console.error(`✗ schema: ${e}`);
  for (const m of r.missing) console.error(`✗ missing: ${m.id}${m.package ? ` (${m.package})` : ''}`);
  for (const c of r.cleanViolations) console.error(`✗ clean package flagged: ${c.id} [${c.severity}] ${c.location.package}`);
  if (!r.ok) process.exit(1);
  console.log('✓ fixture report matches expectations');
}
```

- [ ] **Step 5: Run tests** — `npm test` → Expected: 5 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore LICENSE scripts/verify-fixture.mjs scripts/verify-fixture.test.mjs
git commit -m "chore: scaffold repo and add fixture report verifier"
```

---

### Task 2: Skill consistency linter (TDD)

**Files:**
- Create: `scripts/check-skill.mjs`
- Test: `scripts/check-skill.test.mjs`

- [ ] **Step 1: Write the failing test** — `scripts/check-skill.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSkill, parseFrontmatter } from './check-skill.mjs';

function makeSkill({ name = 'demo-skill', description = 'Use when testing.', body = 'See references/a.md.', refs = { 'a.md': 'Defines `x/y`.' }, expected } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-skill-'));
  const dir = path.join(root, 'demo-skill');
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  for (const [f, c] of Object.entries(refs)) fs.writeFileSync(path.join(dir, 'references', f), c);
  const expDir = path.join(root, 'expected');
  fs.mkdirSync(expDir);
  if (expected) fs.writeFileSync(path.join(expDir, 'f.json'), JSON.stringify(expected));
  return { dir, expDir };
}

test('parseFrontmatter reads name and description', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: Use when x: y\n---\nbody'), { name: 'a', description: 'Use when x: y' });
  assert.equal(parseFrontmatter('no frontmatter'), null);
});

test('valid skill has no errors', () => {
  const { dir, expDir } = makeSkill({ expected: { mustFind: [{ id: 'x/y' }], cleanPackages: [] } });
  assert.deepEqual(checkSkill(dir, expDir), []);
});

test('name must match directory', () => {
  const { dir, expDir } = makeSkill({ name: 'other' });
  assert.ok(checkSkill(dir, expDir).some((e) => e.includes('must equal directory')));
});

test('description must start with "Use when"', () => {
  const { dir, expDir } = makeSkill({ description: 'Audits things.' });
  assert.ok(checkSkill(dir, expDir).some((e) => e.includes('Use when')));
});

test('unlinked and missing references are reported', () => {
  const { dir, expDir } = makeSkill({ body: 'See references/missing.md.', refs: { 'a.md': '' } });
  const errors = checkSkill(dir, expDir);
  assert.ok(errors.some((e) => e.includes('references/missing.md')));
  assert.ok(errors.some((e) => e.includes('references/a.md is not linked')));
});

test('expected finding ids must be defined in a reference', () => {
  const { dir, expDir } = makeSkill({ expected: { mustFind: [{ id: 'nope/missing' }], cleanPackages: [] } });
  assert.ok(checkSkill(dir, expDir).some((e) => e.includes('nope/missing')));
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test` → FAIL: cannot find `check-skill.mjs`.

- [ ] **Step 3: Implement** — `scripts/check-skill.mjs`

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  return fm;
}

export function checkSkill(skillDir, expectedDir) {
  const errors = [];
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return [`missing ${skillPath}`];
  const skill = fs.readFileSync(skillPath, 'utf8');
  const fm = parseFrontmatter(skill);
  const dirName = path.basename(skillDir);
  if (!fm) errors.push('SKILL.md: missing frontmatter');
  else {
    if (fm.name !== dirName) errors.push(`SKILL.md: name "${fm.name}" must equal directory "${dirName}"`);
    if (!fm.description) errors.push('SKILL.md: missing description');
    else {
      if (!fm.description.startsWith('Use when')) errors.push('SKILL.md: description must start with "Use when"');
      if (fm.description.length > 1024) errors.push('SKILL.md: description exceeds 1024 characters');
    }
  }
  const refDir = path.join(skillDir, 'references');
  const refs = fs.existsSync(refDir) ? fs.readdirSync(refDir).filter((f) => f.endsWith('.md')) : [];
  const linked = new Set([...skill.matchAll(/references\/([\w-]+\.md)/g)].map((m) => m[1]));
  for (const l of linked) if (!refs.includes(l)) errors.push(`SKILL.md links missing file references/${l}`);
  for (const r of refs) if (!linked.has(r)) errors.push(`references/${r} is not linked from SKILL.md`);
  const corpus = refs.map((r) => fs.readFileSync(path.join(refDir, r), 'utf8')).join('\n');
  if (expectedDir && fs.existsSync(expectedDir)) {
    for (const f of fs.readdirSync(expectedDir).filter((x) => x.endsWith('.json'))) {
      const exp = JSON.parse(fs.readFileSync(path.join(expectedDir, f), 'utf8'));
      for (const { id } of exp.mustFind) {
        if (!corpus.includes('`' + id + '`')) errors.push(`${f}: finding id ${id} is not defined in any reference file`);
      }
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkSkill(path.join(root, 'skills', 'monorepo-doctor'), path.join(root, 'fixtures', 'expected'));
  for (const e of errors) console.error(`✗ ${e}`);
  if (errors.length) process.exit(1);
  console.log('✓ skill is consistent');
}
```

- [ ] **Step 4: Run tests** — `npm test` → Expected: 11 pass. (`npm run check` will fail until Task 14 — expected.)

- [ ] **Step 5: Commit**

```bash
git add scripts/check-skill.mjs scripts/check-skill.test.mjs
git commit -m "chore: add skill consistency linter"
```

---
### Task 3: Fixture — generic pnpm workspace

Seeded issues (each maps to an expected id):
- `@acme/ui` ↔ `@acme/app` declare each other → `circular-deps/package-cycle`
- `@acme/utils` `src/a.ts` ↔ `src/b.ts` → `circular-deps/file-cycle`
- `@acme/app` imports `@acme/ui/src/button` → `boundaries/deep-import`
- `@acme/utils` imports `../../ui/src/button` without depending on ui → `ci-coverage/undeclared-workspace-dependency`
- `@acme/app` has a test file but no `test` script → `ci-coverage/missing-test-script`
- CI workflow never runs tests → `ci-coverage/tests-not-run-in-ci`
- root `build: pnpm -r build` → `caching/uncached-root-script`
- `@acme/ui` is public with no `files` field and a spec file → `prod-leakage/test-files-in-package`
- `@acme/ui` has `vitest` in `dependencies` → `prod-leakage/test-lib-in-dependencies`
- `@acme/ui` `tsconfig.build.json` includes `src` without excluding tests → `prod-leakage/build-tsconfig-includes-tests`
- `@acme/clean` is the control: no medium+ findings allowed.

**Files (all under `fixtures/generic-pnpm/`):**

- [ ] **Step 1: Root files**

`package.json`
```json
{
  "name": "generic-pnpm-fixture",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test"
  }
}
```

`pnpm-workspace.yaml`
```yaml
packages:
  - "packages/*"
```

`pnpm-lock.yaml`
```yaml
lockfileVersion: '9.0'
```

`.github/workflows/ci.yml`
```yaml
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
```

- [ ] **Step 2: `packages/ui`**

`packages/ui/package.json`
```json
{
  "name": "@acme/ui",
  "version": "1.0.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@acme/app": "workspace:*",
    "vitest": "^2.1.0"
  }
}
```

`packages/ui/tsconfig.build.json`
```json
{
  "compilerOptions": { "outDir": "dist", "declaration": true, "module": "ESNext", "target": "ES2022", "moduleResolution": "Bundler" },
  "include": ["src"]
}
```

`packages/ui/src/index.ts`
```ts
export { Button } from './button';
```

`packages/ui/src/button.ts`
```ts
export const Button = (label: string): string => `<button>${label}</button>`;
```

`packages/ui/src/button.spec.ts`
```ts
import { describe, expect, it } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('renders the label', () => {
    expect(Button('Save')).toBe('<button>Save</button>');
  });
});
```

- [ ] **Step 3: `packages/app`**

`packages/app/package.json`
```json
{
  "name": "@acme/app",
  "private": true,
  "scripts": { "build": "tsc" },
  "dependencies": { "@acme/ui": "workspace:*" }
}
```

`packages/app/src/main.ts`
```ts
import { Button } from '@acme/ui/src/button';

export const render = (): string => Button('Go');
```

`packages/app/src/main.test.ts`
```ts
import { expect, it } from 'vitest';
import { render } from './main';

it('renders', () => {
  expect(render()).toContain('Go');
});
```

- [ ] **Step 4: `packages/utils`**

`packages/utils/package.json`
```json
{
  "name": "@acme/utils",
  "version": "1.0.0",
  "main": "./dist/index.js",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run"
  },
  "devDependencies": { "vitest": "^2.1.0" }
}
```

`packages/utils/tsconfig.build.json`
```json
{
  "compilerOptions": { "outDir": "dist", "declaration": true, "module": "ESNext", "target": "ES2022", "moduleResolution": "Bundler" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/utils/src/index.ts`
```ts
export { label } from './format';
export { a } from './a';
```

`packages/utils/src/format.ts`
```ts
import { Button } from '../../ui/src/button';

export const label = (text: string): string => Button(text.toUpperCase());
```

`packages/utils/src/a.ts`
```ts
import { b } from './b';

export const a = (): number => b() + 1;
```

`packages/utils/src/b.ts`
```ts
import { a } from './a';

export const b = (): number => 1;
export const callA = (): number => a();
```

`packages/utils/src/format.test.ts`
```ts
import { expect, it } from 'vitest';
import { label } from './format';

it('uppercases', () => {
  expect(label('ok')).toContain('OK');
});
```

- [ ] **Step 5: `packages/clean` (control)**

`packages/clean/package.json`
```json
{
  "name": "@acme/clean",
  "version": "1.0.0",
  "type": "module",
  "license": "MIT",
  "main": "./src/index.js",
  "exports": { ".": "./src/index.js" },
  "files": ["src"],
  "scripts": { "test": "node --test test/" }
}
```

`packages/clean/src/index.js`
```js
export const add = (a, b) => a + b;
```

`packages/clean/test/index.test.js`
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/index.js';

test('add', () => assert.equal(add(1, 2), 3));
```

- [ ] **Step 6: Expected findings** — `fixtures/expected/generic-pnpm.json`

```json
{
  "fixture": "generic-pnpm",
  "cleanPackages": ["@acme/clean"],
  "mustFind": [
    { "id": "circular-deps/package-cycle" },
    { "id": "circular-deps/file-cycle", "package": "@acme/utils" },
    { "id": "boundaries/deep-import", "package": "@acme/app" },
    { "id": "ci-coverage/undeclared-workspace-dependency", "package": "@acme/utils" },
    { "id": "ci-coverage/missing-test-script", "package": "@acme/app" },
    { "id": "ci-coverage/tests-not-run-in-ci" },
    { "id": "caching/uncached-root-script" },
    { "id": "prod-leakage/test-files-in-package", "package": "@acme/ui" },
    { "id": "prod-leakage/test-lib-in-dependencies", "package": "@acme/ui" },
    { "id": "prod-leakage/build-tsconfig-includes-tests", "package": "@acme/ui" }
  ]
}
```

- [ ] **Step 7: Commit**

```bash
git add fixtures/generic-pnpm fixtures/expected/generic-pnpm.json
git commit -m "test: add generic pnpm fixture with seeded issues"
```

---

### Task 4: Fixture — Nx

Seeded issues:
- `targetDefaults.build` cacheable, no `outputs`; `@nxf/api` builds to `lib/` (not an Nx default output dir) → `caching/missing-outputs` (`@nxf/api`)
- No `production` named input → `caching/build-inputs-include-tests`
- `@nxf/api` reads `process.env.API_URL`, not declared in any `inputs` → `caching/undeclared-env`
- `targetDefaults.test.inputs` has no `^` entry → `ci-coverage/nx-test-inputs-ignore-deps`
- CI uses `nx affected` with default shallow checkout and no base → `ci-coverage/shallow-checkout-affected`, `ci-coverage/nx-affected-base-missing`
- ESLint config lacks `@nx/enforce-module-boundaries` → `boundaries/nx-missing-module-boundaries-rule`
- `libs/api/project.json` has no tags → `boundaries/nx-untagged-project` (`@nxf/api`)
- `@nxf/clean` is the control.

**Files (all under `fixtures/nx/`):**

- [ ] **Step 1: Root files**

`package.json`
```json
{
  "name": "nx-fixture",
  "private": true,
  "workspaces": ["libs/*"],
  "devDependencies": { "nx": "21.0.0" }
}
```

`package-lock.json`
```json
{ "name": "nx-fixture", "lockfileVersion": 3, "requires": true, "packages": {} }
```

`nx.json`
```json
{
  "namedInputs": {
    "default": ["{projectRoot}/**/*"]
  },
  "targetDefaults": {
    "build": { "cache": true, "dependsOn": ["^build"] },
    "test": { "cache": true, "inputs": ["default"] }
  }
}
```

`eslint.config.mjs`
```js
export default [];
```

`.github/workflows/ci.yml`
```yaml
name: CI
on: [pull_request]
jobs:
  main:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx nx affected -t build test
```

- [ ] **Step 2: `libs/api`**

`libs/api/package.json`
```json
{
  "name": "@nxf/api",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.lib.json",
    "test": "vitest run"
  }
}
```

`libs/api/project.json`
```json
{ "name": "@nxf/api", "targets": {} }
```

`libs/api/tsconfig.lib.json`
```json
{
  "compilerOptions": { "outDir": "lib", "module": "ESNext", "target": "ES2022", "moduleResolution": "Bundler" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`libs/api/src/client.ts`
```ts
export const baseUrl = (): string => process.env.API_URL ?? 'http://localhost:3000';
```

`libs/api/src/client.test.ts`
```ts
import { expect, it } from 'vitest';
import { baseUrl } from './client';

it('has a default', () => {
  expect(baseUrl()).toMatch(/^http/);
});
```

- [ ] **Step 3: `libs/clean` (control)**

`libs/clean/package.json`
```json
{
  "name": "@nxf/clean",
  "private": true,
  "scripts": { "test": "vitest run" }
}
```

`libs/clean/project.json`
```json
{ "name": "@nxf/clean", "tags": ["scope:shared", "type:util"] }
```

`libs/clean/src/index.ts`
```ts
export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
```

`libs/clean/src/index.spec.ts`
```ts
import { expect, it } from 'vitest';
import { sum } from './index';

it('sums', () => expect(sum([1, 2])).toBe(3));
```

- [ ] **Step 4: Expected findings** — `fixtures/expected/nx.json`

```json
{
  "fixture": "nx",
  "cleanPackages": ["@nxf/clean"],
  "mustFind": [
    { "id": "caching/missing-outputs", "package": "@nxf/api" },
    { "id": "caching/build-inputs-include-tests" },
    { "id": "caching/undeclared-env", "package": "@nxf/api" },
    { "id": "ci-coverage/nx-test-inputs-ignore-deps" },
    { "id": "ci-coverage/shallow-checkout-affected" },
    { "id": "ci-coverage/nx-affected-base-missing" },
    { "id": "boundaries/nx-missing-module-boundaries-rule" },
    { "id": "boundaries/nx-untagged-project", "package": "@nxf/api" }
  ]
}
```

- [ ] **Step 5: Commit**

```bash
git add fixtures/nx fixtures/expected/nx.json
git commit -m "test: add Nx fixture with seeded issues"
```

---

### Task 5: Fixture — Turborepo

Seeded issues:
- `build` task has no `outputs` → `caching/missing-outputs`
- `build` has no `inputs` excluding tests → `caching/build-inputs-include-tests`
- `@tf/web` reads `process.env.API_URL`, not in `env`/`globalEnv` → `caching/undeclared-env`
- `lint` has `cache: false` → `caching/turbo-cache-disabled`
- `test` has no `dependsOn` with `^` → `ci-coverage/turbo-test-missing-dependson`
- CI uses `--filter=...[origin/main]` with a shallow checkout → `ci-coverage/shallow-checkout-affected`
- `@tf/clean` is the control.

**Files (all under `fixtures/turborepo/`):**

- [ ] **Step 1: Root files**

`package.json`
```json
{
  "name": "turborepo-fixture",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint"
  },
  "devDependencies": { "turbo": "^2.5.0" }
}
```

`pnpm-workspace.yaml`
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`pnpm-lock.yaml`
```yaml
lockfileVersion: '9.0'
```

`turbo.json`
```json
{
  "$schema": "https://turborepo.com/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"] },
    "test": {},
    "lint": { "cache": false }
  }
}
```

`.github/workflows/ci.yml`
```yaml
name: CI
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run build test --filter=...[origin/main]
```

- [ ] **Step 2: `apps/web`**

`apps/web/package.json`
```json
{
  "name": "@tf/web",
  "private": true,
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": { "@tf/clean": "workspace:*" }
}
```

`apps/web/tsconfig.json`
```json
{
  "compilerOptions": { "outDir": "dist", "module": "ESNext", "target": "ES2022", "moduleResolution": "Bundler" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`apps/web/src/config.ts`
```ts
import { greet } from '@tf/clean';

export const apiUrl = (): string => process.env.API_URL ?? '/api';
export const hello = (): string => greet('web');
```

`apps/web/src/config.test.ts`
```ts
import { expect, it } from 'vitest';
import { apiUrl } from './config';

it('defaults', () => expect(apiUrl()).toBe('/api'));
```

- [ ] **Step 3: `packages/clean` (control)**

`packages/clean/package.json`
```json
{
  "name": "@tf/clean",
  "private": true,
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "eslint ."
  }
}
```

`packages/clean/tsconfig.json`
```json
{
  "compilerOptions": { "outDir": "dist", "declaration": true, "module": "ESNext", "target": "ES2022", "moduleResolution": "Bundler" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/clean/src/index.ts`
```ts
export const greet = (name: string): string => `hello ${name}`;
```

`packages/clean/src/index.test.ts`
```ts
import { expect, it } from 'vitest';
import { greet } from './index';

it('greets', () => expect(greet('x')).toBe('hello x'));
```

- [ ] **Step 4: Expected findings** — `fixtures/expected/turborepo.json`

```json
{
  "fixture": "turborepo",
  "cleanPackages": ["@tf/clean"],
  "mustFind": [
    { "id": "caching/missing-outputs" },
    { "id": "caching/build-inputs-include-tests" },
    { "id": "caching/undeclared-env", "package": "@tf/web" },
    { "id": "caching/turbo-cache-disabled" },
    { "id": "ci-coverage/turbo-test-missing-dependson" },
    { "id": "ci-coverage/shallow-checkout-affected" }
  ]
}
```

- [ ] **Step 5: Commit**

```bash
git add fixtures/turborepo fixtures/expected/turborepo.json
git commit -m "test: add Turborepo fixture with seeded issues"
```

---
### Task 6: `references/report-format.md` (findings contract + render)

Written first among the references because every check writes to this contract.

**Files:**
- Create: `skills/monorepo-doctor/references/report-format.md`

- [ ] **Step 1: Write the reference** with exactly these sections:

````markdown
# Report format

Every check writes one file: `$TMPDIR/monorepo-doctor/findings/<check>.json`
where `<check>` is one of `boundaries`, `circular-deps`, `caching`, `ci-coverage`, `prod-leakage`.

```json
{
  "status": "ok | partial | skipped | not-run",
  "reason": "required unless status is ok",
  "findings": [
    {
      "id": "caching/missing-outputs",
      "severity": "critical | high | medium | low",
      "title": "One line, specific: name the package/task",
      "location": { "file": "turbo.json", "line": 4, "package": "@acme/ui" },
      "evidence": "The exact config/code/command output that proves it",
      "fix": "Concrete change, ideally a snippet"
    }
  ]
}
```

- `ok`: check ran fully. `partial`: some sub-steps skipped (say which in `reason`).
  `skipped`: check could not run at all. `not-run`: user scoped it out.
- `location.file` is relative to the workspace root. Include `package` whenever the finding belongs to one package.
- Never emit a finding without `evidence`. If you are unsure, lower severity and say so in `evidence`; do not guess.
- Use only the ids defined in the check reference files.

## Severity rubric

| Severity | Meaning |
|---|---|
| critical | Wrong code can ship or tests are silently skipped for real changes |
| high | Likely incorrect builds/caching or broken CI signal |
| medium | Correctness risk under specific conditions, or a boundary erosion |
| low | Hygiene, performance, or maintainability |

Severity may be lowered one level with a stated reason (e.g., package is private). Never raise it.

## Render

After all checks, run this snippet. Arguments: output directory (default: workspace root).

```bash
cat > "${TMPDIR:-/tmp}/monorepo-doctor/render.mjs" <<'EOF'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const work = path.join(os.tmpdir(), 'monorepo-doctor');
const ws = JSON.parse(fs.readFileSync(path.join(work, 'workspace.json'), 'utf8'));
const outDir = path.resolve(process.argv[2] ?? ws.root);
const CHECKS = ['boundaries', 'circular-deps', 'caching', 'ci-coverage', 'prod-leakage'];
const SEV = ['critical', 'high', 'medium', 'low'];
const checks = [], findings = [];
for (const check of CHECKS) {
  const p = path.join(work, 'findings', `${check}.json`);
  const r = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { status: 'not-run', reason: 'no findings file', findings: [] };
  checks.push({ check, status: r.status, reason: r.reason, findingCount: r.findings.length });
  for (const f of r.findings) findings.push({ ...f, check });
}
findings.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || a.id.localeCompare(b.id));
const summary = Object.fromEntries(SEV.map((s) => [s, findings.filter((f) => f.severity === s).length]));
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  workspace: { root: ws.root, packageManager: ws.packageManager, orchestrators: ws.orchestrators, packageCount: ws.packages.length },
  summary, checks, findings,
};
fs.writeFileSync(path.join(outDir, 'monorepo-doctor-report.json'), JSON.stringify(report, null, 2) + '\n');
const loc = (l) => `\`${l.file}${l.line ? `:${l.line}` : ''}\`${l.package ? ` (${l.package})` : ''}`;
const md = [
  '# Monorepo Doctor Report', '',
  `**Workspace:** ${ws.packageManager} · ${ws.orchestrators.map((o) => o.name).join(', ') || 'no orchestrator'} · ${ws.packages.length} packages`, '',
  `**Summary:** ${SEV.map((s) => `${summary[s]} ${s}`).join(' · ')}`, '',
  '| Check | Status | Findings | Note |', '|---|---|---|---|',
  ...checks.map((c) => `| ${c.check} | ${c.status} | ${c.findingCount} | ${c.reason ?? ''} |`), '',
];
for (const s of SEV) {
  const fs_ = findings.filter((f) => f.severity === s);
  if (!fs_.length) continue;
  md.push(`## ${s[0].toUpperCase() + s.slice(1)}`, '');
  for (const f of fs_) {
    md.push(`### ${f.title}`, '', `- **id:** \`${f.id}\``, `- **where:** ${loc(f.location)}`, '', '**Evidence**', '', '```', f.evidence, '```', '', `**Fix:** ${f.fix}`, '');
  }
}
if (!findings.length) md.push('No findings. 🎉', '');
fs.writeFileSync(path.join(outDir, 'monorepo-doctor-report.md'), md.join('\n'));
console.log(JSON.stringify({ outDir, summary }));
EOF
node "${TMPDIR:-/tmp}/monorepo-doctor/render.mjs" "<output-dir>"
```

## CI mode

When the user asks for CI mode (or a fail threshold), after rendering run:

```bash
node -e '
const r = require(process.argv[1]);
const order = ["low","medium","high","critical"];
const min = order.indexOf(process.argv[2] || "high");
const bad = r.findings.filter(f => order.indexOf(f.severity) >= min);
for (const f of bad) console.error(`${f.severity.toUpperCase()} ${f.id} ${f.location.file}`);
process.exit(bad.length ? 1 : 0);
' "<output-dir>/monorepo-doctor-report.json" high
```
````

- [ ] **Step 2: Smoke-test the render snippet** with a hand-made work dir:

```bash
W="$(node -p 'require("os").tmpdir()')/monorepo-doctor"
rm -rf "$W" && mkdir -p "$W/findings" /tmp/mrd-render
echo '{"root":"/tmp/mrd-render","packageManager":"pnpm","orchestrators":[],"packages":[{"name":"a"}]}' > "$W/workspace.json"
echo '{"status":"ok","findings":[{"id":"circular-deps/package-cycle","severity":"high","title":"a ↔ b","location":{"file":"packages/a/package.json"},"evidence":"a -> b -> a","fix":"break it"}]}' > "$W/findings/circular-deps.json"
# extract the render snippet from the reference and run it
node -e 'const t=require("fs").readFileSync("skills/monorepo-doctor/references/report-format.md","utf8");const m=t.match(/<<.EOF.\n([\s\S]*?)\nEOF/);require("fs").writeFileSync(process.argv[1],m[1])' "$W/render.mjs"
node "$W/render.mjs" /tmp/mrd-render
cat /tmp/mrd-render/monorepo-doctor-report.md
```
Expected: JSON summary `{"critical":0,"high":1,...}`; Markdown shows 1 high finding and 4 checks with status `not-run`.

- [ ] **Step 3: Commit**

```bash
git add skills/monorepo-doctor/references/report-format.md
git commit -m "feat(skill): add report format, severity rubric and render snippet"
```

---
### Task 7: `references/detection.md` (Phase 1)

**Files:**
- Create: `skills/monorepo-doctor/references/detection.md`

- [ ] **Step 1: Write the reference**

````markdown
# Phase 1 — Detection

Goal: build an inventory at `$TMPDIR/monorepo-doctor/workspace.json`. Every later phase reads it.
This phase resets the work directory.

Run from the workspace root (the directory the user pointed at; default: current directory):

```bash
mkdir -p "${TMPDIR:-/tmp}/monorepo-doctor"
cat > "${TMPDIR:-/tmp}/monorepo-doctor/detect.mjs" <<'EOF'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(process.argv[2] ?? '.');
const work = path.join(os.tmpdir(), 'monorepo-doctor');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, 'findings'), { recursive: true });
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const exists = (p) => fs.existsSync(path.join(root, p));

const pm = exists('pnpm-lock.yaml') || exists('pnpm-workspace.yaml') ? 'pnpm'
  : exists('bun.lockb') || exists('bun.lock') ? 'bun'
  : exists('yarn.lock') ? 'yarn'
  : exists('package-lock.json') ? 'npm' : 'unknown';

const rootPkg = readJson(path.join(root, 'package.json')) ?? {};
let globs = [];
if (exists('pnpm-workspace.yaml')) {
  const y = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const block = y.match(/^packages:\s*\n((?:[ \t]+-.*\n?|[ \t]*#.*\n?|\s*\n)*)/m);
  if (block) globs = [...block[1].matchAll(/-\s*['"]?([^'"\n#]+?)['"]?\s*(?:#.*)?$/gm)].map((m) => m[1].trim());
}
if (!globs.length) globs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages ?? [];
const include = globs.filter((g) => !g.startsWith('!'));
const exclude = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));

const orchestrators = [];
if (exists('nx.json')) orchestrators.push({ name: 'nx', installed: exists('node_modules/.bin/nx') });
if (exists('turbo.json')) orchestrators.push({ name: 'turbo', installed: exists('node_modules/.bin/turbo') });

const SKIP = /(^|\/)(node_modules|dist|build|\.git|\.nx|\.turbo|coverage)(\/|$)/;
const dirs = new Map();
for (const g of include) {
  for (const m of fs.globSync(`${g.replace(/\/$/, '')}/package.json`, { cwd: root, exclude: exclude.map((e) => `${e.replace(/\/$/, '')}/package.json`) })) {
    if (!SKIP.test(m)) dirs.set(path.dirname(m), 'package.json');
  }
}
if (orchestrators.some((o) => o.name === 'nx')) {
  for (const m of fs.globSync('**/project.json', { cwd: root })) {
    if (SKIP.test(m)) continue;
    const d = path.dirname(m);
    if (d !== '.' && !dirs.has(d)) dirs.set(d, 'project.json');
  }
}

const packages = [];
for (const [dir, source] of dirs) {
  const abs = path.join(root, dir);
  const pkg = readJson(path.join(abs, 'package.json')) ?? {};
  const proj = readJson(path.join(abs, 'project.json'));
  const name = pkg.name ?? proj?.name ?? dir;
  const exportKeys = typeof pkg.exports === 'string' ? ['.']
    : pkg.exports && typeof pkg.exports === 'object' ? Object.keys(pkg.exports).filter((k) => k.startsWith('.')) : [];
  if (pkg.exports && !exportKeys.length) exportKeys.push('.');
  const allDeps = { ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.devDependencies, ...pkg.dependencies };
  packages.push({
    name, dir: dir.split(path.sep).join('/'), source,
    private: pkg.private === true, version: pkg.version ?? null,
    scripts: pkg.scripts ?? {}, files: pkg.files ?? null, main: pkg.main ?? null,
    exports: pkg.exports ?? null, exportKeys,
    dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {}, allDeps,
    tags: proj?.tags ?? pkg.nx?.tags ?? [], nxTargets: { ...pkg.nx?.targets, ...proj?.targets }, nxName: proj?.name ?? null,
  });
}
const names = new Set(packages.map((p) => p.name));
for (const p of packages) {
  p.workspaceDeps = Object.keys(p.allDeps).filter((d) => names.has(d));
  p.hasTestScript = typeof p.scripts.test === 'string' && !/no test specified/.test(p.scripts.test);
}

const ci = [
  ...fs.globSync('.github/workflows/*.{yml,yaml}', { cwd: root }),
  ...['.gitlab-ci.yml', 'azure-pipelines.yml', '.circleci/config.yml', 'bitbucket-pipelines.yml'].filter(exists),
];

const ws = {
  root, packageManager: pm, orchestrators, workspaceGlobs: globs,
  rootScripts: rootPkg.scripts ?? {},
  hasNodeModules: exists('node_modules'),
  ciFiles: ci.map((c) => c.split(path.sep).join('/')),
  packages,
};
fs.writeFileSync(path.join(work, 'workspace.json'), JSON.stringify(ws, null, 2));
if (!packages.length) { console.error('NO_WORKSPACE: no workspace packages found under ' + root); process.exit(2); }
console.log(JSON.stringify({ root, packageManager: pm, orchestrators, packages: packages.length, ciFiles: ws.ciFiles.length }));
EOF
node "${TMPDIR:-/tmp}/monorepo-doctor/detect.mjs" "<workspace-root>"
```

## Interpreting the result

- Exit code 2 / `NO_WORKSPACE`: this is not a monorepo. Stop and tell the user; do not produce a report.
- `orchestrators[].installed: false`: never call `npx nx` / `npx turbo` (it would download a different version). Use static config analysis only, and mark dependent sub-steps `partial`.
- `hasNodeModules: false`: skip `knip` and any step that needs resolved dependencies; mark `partial`.
- `packages[].source === "project.json"`: an Nx project without its own package.json — package.json-based rules (missing test script, undeclared dependency, npm pack) do not apply to it.
- Print a one-line summary of the inventory to the user before continuing.
````

- [ ] **Step 2: Run detection against all three fixtures**

```bash
W="$(node -p 'require("os").tmpdir()')/monorepo-doctor"
mkdir -p "$W"
node -e 'const t=require("fs").readFileSync("skills/monorepo-doctor/references/detection.md","utf8");require("fs").writeFileSync(process.argv[1],t.match(/<<.EOF.\n([\s\S]*?)\nEOF/)[1])' "$W/detect.mjs"
cp "$W/detect.mjs" /tmp/mrd-detect.mjs
for f in generic-pnpm nx turborepo; do node /tmp/mrd-detect.mjs "fixtures/$f"; done
```
Expected (one line each):
- generic-pnpm: `packageManager":"pnpm"`, `packages":4`, `ciFiles":1`
- nx: `packageManager":"npm"`, orchestrators `[{"name":"nx","installed":false}]`, `packages":2`
- turborepo: `packageManager":"pnpm"`, orchestrators `[{"name":"turbo","installed":false}]`, `packages":2`

Also: `node /tmp/mrd-detect.mjs /tmp` → exit 2 with `NO_WORKSPACE`.

- [ ] **Step 3: Commit**

```bash
git add skills/monorepo-doctor/references/detection.md
git commit -m "feat(skill): add detection phase"
```

---
### Task 8: `references/scan.md` (Phase 2 — shared source scan)

One pass over source files feeds boundaries, circular-deps, caching (env vars) and ci-coverage.

**Files:**
- Create: `skills/monorepo-doctor/references/scan.md`

- [ ] **Step 1: Write the reference**

````markdown
# Phase 2 — Source scan

Reads `workspace.json`, walks every package's source files, and writes `$TMPDIR/monorepo-doctor/scan.json`:

| key | content |
|---|---|
| `packages[name]` | `{ sourceFiles, testFiles: [file], loc }` |
| `imports` | every import that crosses a package boundary: `{ from, target, kind, spec, subpath, file, line, isTest, declared, deep }` |
| `fileEdges[name]` | intra-package `[fromFile, toFile]` edges from value imports (type-only imports excluded) |
| `env` | `{ package, file, line, name }` for `process.env.X`, `process.env['X']`, `import.meta.env.X` |

`kind`: `relative` (`../../other-pkg/src/x`), `package` (`@scope/pkg/sub`), `alias` (tsconfig `paths`).
`declared`: the importing package lists the target in any dependency field.
`deep`: the import bypasses the target's public API — any `relative` cross-package import, a subpath starting with `src/`, `lib/` or `internal/`, or a subpath not covered by the target's `exports` keys.

```bash
cat > "${TMPDIR:-/tmp}/monorepo-doctor/scan.mjs" <<'EOF'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const work = path.join(os.tmpdir(), 'monorepo-doctor');
const ws = JSON.parse(fs.readFileSync(path.join(work, 'workspace.json'), 'utf8'));
const root = ws.root;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.turbo', '.next', '.nx', '.git', 'lib-cov']);
const SRC = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__)\//;
const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const toPosix = (p) => p.split(path.sep).join('/');
const byDir = [...ws.packages].sort((a, b) => b.dir.length - a.dir.length);
const owner = (relFile) => byDir.find((p) => relFile === p.dir || relFile.startsWith(p.dir + '/'));
const byName = new Map(ws.packages.map((p) => [p.name, p]));

const readJsonc = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\/|(?<![:"'])\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
};
const tsBase = readJsonc(path.join(root, 'tsconfig.base.json')) ?? readJsonc(path.join(root, 'tsconfig.json')) ?? {};
const baseUrl = path.join(root, tsBase.compilerOptions?.baseUrl ?? '.');
const aliases = Object.entries(tsBase.compilerOptions?.paths ?? {}).map(([k, v]) => ({ key: k, target: v[0] }));

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (SRC.test(e.name) && !e.name.endsWith('.d.ts')) out.push(path.join(dir, e.name));
  }
  return out;
}
function resolveFile(abs) {
  const cands = [abs, ...EXTS.map((e) => abs + e), ...EXTS.map((e) => path.join(abs, 'index' + e))];
  if (/\.[cm]?js$/.test(abs)) cands.push(...['.ts', '.tsx', '.mts', '.cts'].map((e) => abs.replace(/\.[cm]?js$/, e)));
  return cands.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) ?? null;
}
function covered(exportKeys, subpath) {
  if (!exportKeys.length) return true;
  const want = './' + subpath;
  return exportKeys.some((k) => k === want || (k.includes('*') && new RegExp('^' + k.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(want)));
}
const lineAt = (text, idx) => text.slice(0, idx).split('\n').length;

const scan = { packages: {}, imports: [], fileEdges: {}, env: [] };
for (const pkg of ws.packages) {
  const files = walk(path.join(root, pkg.dir), []).filter((f) => owner(toPosix(path.relative(root, f)))?.name === pkg.name);
  const info = { sourceFiles: 0, testFiles: [], loc: 0 };
  const edges = [];
  for (const abs of files) {
    const file = toPosix(path.relative(root, abs));
    const isTest = TEST.test(file);
    const text = fs.readFileSync(abs, 'utf8');
    if (isTest) info.testFiles.push(file); else { info.sourceFiles++; info.loc += text.split('\n').length; }
    const specs = [];
    for (const m of text.matchAll(/^[ \t]*(import|export)\s+(type\s+)?([^'";]*?\bfrom\s+)?['"]([^'"\n]+)['"]/gm)) {
      if (m[2]) continue;
      if (m[1] === 'export' && !m[3]) continue;
      specs.push({ spec: m[4], line: lineAt(text, m.index + m[0].search(/\S/)) });
    }
    for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) specs.push({ spec: m[1], line: lineAt(text, m.index) });
    for (const m of text.matchAll(/\bprocess\.env\.([A-Za-z_][\w]*)|\bprocess\.env\[\s*['"]([^'"]+)['"]\s*\]|\bimport\.meta\.env\.([A-Za-z_][\w]*)/g)) {
      scan.env.push({ package: pkg.name, file, line: lineAt(text, m.index), name: m[1] ?? m[2] ?? m[3] });
    }
    for (const { spec, line } of specs) {
      let kind, target, subpath = '', resolved = null;
      if (spec.startsWith('.')) {
        resolved = resolveFile(path.resolve(path.dirname(abs), spec));
        const relTarget = toPosix(path.relative(root, resolved ?? path.resolve(path.dirname(abs), spec)));
        const t = owner(relTarget);
        if (!t) continue;
        if (t.name === pkg.name) { if (resolved) edges.push([file, toPosix(path.relative(root, resolved))]); continue; }
        kind = 'relative'; target = t.name; subpath = relTarget.slice(t.dir.length + 1);
      } else {
        const parts = spec.split('/');
        const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        if (byName.has(name)) { kind = 'package'; target = name; subpath = parts.slice(spec.startsWith('@') ? 2 : 1).join('/'); }
        else {
          const a = aliases.find((x) => x.key === spec || (x.key.endsWith('*') && spec.startsWith(x.key.slice(0, -1))));
          if (!a) continue;
          const mapped = a.key.endsWith('*') ? a.target.replace('*', spec.slice(a.key.length - 1)) : a.target;
          const t = owner(toPosix(path.relative(root, path.resolve(baseUrl, mapped))));
          if (!t || t.name === pkg.name) continue;
          kind = 'alias'; target = t.name; subpath = '';
        }
      }
      const tp = byName.get(target);
      const deep = kind === 'relative' || /^(src|lib|internal)(\/|$)/.test(subpath) || (subpath !== '' && !covered(tp.exportKeys, subpath));
      scan.imports.push({ from: pkg.name, target, kind, spec, subpath, file, line, isTest, declared: pkg.workspaceDeps.includes(target), deep });
    }
  }
  scan.packages[pkg.name] = info;
  scan.fileEdges[pkg.name] = edges;
}
fs.writeFileSync(path.join(work, 'scan.json'), JSON.stringify(scan, null, 2));
console.log(JSON.stringify({
  packages: Object.keys(scan.packages).length,
  crossPackageImports: scan.imports.length,
  undeclared: scan.imports.filter((i) => !i.declared).length,
  deep: scan.imports.filter((i) => i.deep).length,
  envReads: scan.env.length,
}));
EOF
node "${TMPDIR:-/tmp}/monorepo-doctor/scan.mjs"
```

Notes for the agent:
- The scan is regex-based. Commented-out imports can produce false positives — open the file at `line` to confirm before reporting.
- Type-only imports (`import type …`, `export type … from`) are excluded because they are erased at compile time.
- Huge repos: the scan is linear in file count; if it takes > 2 minutes, tell the user and proceed.
````

- [ ] **Step 2: Run against the generic fixture**

```bash
W="$(node -p 'require("os").tmpdir()')/monorepo-doctor"
node /tmp/mrd-detect.mjs fixtures/generic-pnpm
node -e 'const t=require("fs").readFileSync("skills/monorepo-doctor/references/scan.md","utf8");require("fs").writeFileSync(process.argv[1],t.match(/<<.EOF.\n([\s\S]*?)\nEOF/)[1])' "$W/scan.mjs"
node "$W/scan.mjs"
node -e 'const s=require(process.argv[1]);console.log(s.imports.map(i=>`${i.from}->${i.target} ${i.kind} declared=${i.declared} deep=${i.deep}`).join("\n"));console.log(JSON.stringify(s.fileEdges["@acme/utils"]))' "$W/scan.json"
```
Expected:
```
@acme/app->@acme/ui package declared=true deep=true
@acme/utils->@acme/ui relative declared=false deep=true
```
and `@acme/utils` edges include both `["packages/utils/src/a.ts","packages/utils/src/b.ts"]` and `["packages/utils/src/b.ts","packages/utils/src/a.ts"]`.

Then for the Nx fixture (`node /tmp/mrd-detect.mjs fixtures/nx && node "$W/scan.mjs"`): `envReads` ≥ 1 with name `API_URL` in package `@nxf/api`.

- [ ] **Step 3: Commit**

```bash
git add skills/monorepo-doctor/references/scan.md
git commit -m "feat(skill): add shared source scan phase"
```

---
### Task 9: `references/boundaries.md` (Check 1)

**Files:**
- Create: `skills/monorepo-doctor/references/boundaries.md`

- [ ] **Step 1: Write the reference**

````markdown
# Check 1 — Package boundaries

Question: are packages split along real seams, and is each package's public API respected?
Inputs: `workspace.json`, `scan.json`. Output: `findings/boundaries.json`.

## Rules

| id | severity | detect | evidence |
|---|---|---|---|
| `boundaries/oversized-package` | low | `scan.packages[p].sourceFiles > 500` or `loc > 50000` | counts |
| `boundaries/deep-import` | medium | each `scan.imports` entry with `deep && declared` (undeclared ones are reported by ci-coverage instead) | file:line + import specifier + target's `exports` keys |
| `boundaries/unlisted-dependency` | medium | knip `unlisted` entries | knip output line |
| `boundaries/unused-dependency` | low | knip `dependencies` / `devDependencies` entries | knip output line |
| `boundaries/nx-missing-module-boundaries-rule` | medium | Nx detected and no ESLint config in the root mentions `@nx/enforce-module-boundaries` | list of ESLint config files checked |
| `boundaries/nx-permissive-module-boundaries` | low | the rule exists but `depConstraints` contains `{ sourceTag: '*', onlyDependOnLibsWithTags: ['*'] }` | the config snippet |
| `boundaries/nx-untagged-project` | low | Nx detected, rule absent or permissive, and a project has empty `tags` | project.json path |
| `boundaries/turbo-boundaries-violation` | medium | each violation printed by `turbo boundaries` | output line |

Group `deep-import` findings: one finding per (from, target) pair, listing up to 5 locations in `evidence`; `location` is the first occurrence.

## Steps

1. Load `workspace.json` and `scan.json`. Apply the size and deep-import rules directly.
2. **knip** — only if `hasNodeModules`:
   ```bash
   npx --yes knip --reporter json --include dependencies,unlisted --no-progress --no-exit-code
   ```
   Parse stdout as JSON. Its shape varies by version; look for per-file `dependencies`, `devDependencies` and `unlisted` arrays of `{ name }`. Map the file to its package via `workspace.json`. If knip fails or the output can't be parsed, mark the check `partial` with reason `knip unavailable: <first line of error>`. Do **not** report `unused-dependency` for `@types/*` packages or for tools only referenced in scripts.
3. **Nx** — only if Nx is an orchestrator: read ESLint configs in the root (`eslint.config.{js,mjs,cjs,ts}`, `.eslintrc{,.json,.js,.cjs}`) and every package dir. Apply the three `nx-*` rules. A config that contains the rule name anywhere counts as present.
4. **Turborepo** — only if turbo is an orchestrator **and installed**:
   ```bash
   npx turbo boundaries
   ```
   One finding per reported violation. If the command errors with an unknown-command message (turbo < 2.4), skip this sub-step and note it in `reason`.
5. Write `findings/boundaries.json`.

## Fix guidance

- deep-import: add the subpath to the target's `exports`, or re-export from its entry point, then import from the package root.
- oversized-package: identify clusters by directory and by which consumers import which files (`scan.imports` subpaths); propose 2–3 candidate splits.
- nx-missing-module-boundaries-rule: add `@nx/enforce-module-boundaries` with `depConstraints` based on `scope:*`/`type:*` tags.
````

- [ ] **Step 2: Verify ids** — `grep -o '`boundaries/[a-z-]*`' skills/monorepo-doctor/references/boundaries.md | sort -u | wc -l` → `8`.

- [ ] **Step 3: Commit**

```bash
git add skills/monorepo-doctor/references/boundaries.md
git commit -m "feat(skill): add boundaries check"
```

---

### Task 10: `references/circular-deps.md` (Check 2)

**Files:**
- Create: `skills/monorepo-doctor/references/circular-deps.md`

- [ ] **Step 1: Write the reference**

````markdown
# Check 2 — Circular dependencies

Output: `findings/circular-deps.json`.

| id | severity | detect |
|---|---|---|
| `circular-deps/package-cycle` | high | a cycle in the package graph (`workspaceDeps`, or the Nx project graph when Nx is installed) |
| `circular-deps/file-cycle` | medium | a cycle among a package's own files (`scan.fileEdges`) |

Package cycles break topological builds (`^build` order is undefined), cause stale caches and make packages unpublishable independently.
File cycles cause `undefined` at import time in ESM/CJS and block tree-shaking.

## Steps

1. If Nx is installed, refresh the graph and use it as the package graph:
   ```bash
   npx nx graph --file="${TMPDIR:-/tmp}/monorepo-doctor/nx-graph.json"
   ```
   The file has `graph.dependencies[project] = [{ target }]`. Otherwise use `workspace.json` `workspaceDeps`.
   If Turborepo is installed, `npx turbo run build --dry=json` failing with a message containing `cyclic` is also evidence.
2. Run the cycle snippet:

```bash
cat > "${TMPDIR:-/tmp}/monorepo-doctor/cycles.mjs" <<'EOF'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const work = path.join(os.tmpdir(), 'monorepo-doctor');
const ws = JSON.parse(fs.readFileSync(path.join(work, 'workspace.json'), 'utf8'));
const scan = JSON.parse(fs.readFileSync(path.join(work, 'scan.json'), 'utf8'));
const nxGraphPath = path.join(work, 'nx-graph.json');

function cycles(graph) {
  const found = new Map();
  const state = new Map();
  const stack = [];
  const visit = (n) => {
    state.set(n, 1); stack.push(n);
    for (const m of graph.get(n) ?? []) {
      if (state.get(m) === 1) {
        const cyc = stack.slice(stack.indexOf(m));
        const i = cyc.indexOf([...cyc].sort()[0]);
        const norm = [...cyc.slice(i), ...cyc.slice(0, i)];
        found.set(norm.join('\u0000'), norm);
      } else if (!state.has(m)) visit(m);
    }
    stack.pop(); state.set(n, 2);
  };
  for (const n of graph.keys()) if (!state.has(n)) visit(n);
  return [...found.values()];
}

let pkgGraph;
if (fs.existsSync(nxGraphPath)) {
  const g = JSON.parse(fs.readFileSync(nxGraphPath, 'utf8')).graph;
  pkgGraph = new Map(Object.entries(g.dependencies).map(([k, v]) => [k, v.map((d) => d.target).filter((t) => g.nodes[t])]));
} else {
  pkgGraph = new Map(ws.packages.map((p) => [p.name, p.workspaceDeps]));
}
const byName = new Map(ws.packages.map((p) => [p.name, p]));
const findings = [];
for (const c of cycles(pkgGraph)) {
  const first = byName.get(c[0]);
  findings.push({
    id: 'circular-deps/package-cycle', severity: 'high',
    title: `Package cycle: ${[...c, c[0]].join(' → ')}`,
    location: { file: first ? `${first.dir}/package.json` : 'package.json', package: c[0] },
    evidence: c.map((n, i) => `${n} depends on ${c[(i + 1) % c.length]}`).join('\n'),
    fix: 'Extract the shared code into a new package both can depend on, or invert one edge (dependency injection / events). Remove the back-edge from package.json.',
  });
}
for (const [pkg, edges] of Object.entries(scan.fileEdges)) {
  const g = new Map();
  for (const [a, b] of edges) { if (!g.has(a)) g.set(a, []); g.get(a).push(b); }
  for (const c of cycles(g)) {
    findings.push({
      id: 'circular-deps/file-cycle', severity: 'medium',
      title: `File cycle in ${pkg} (${c.length} files)`,
      location: { file: c[0], package: pkg },
      evidence: [...c, c[0]].join('\n → '),
      fix: 'Move the shared symbols into a third module that both import, or merge the files.',
    });
  }
}
fs.writeFileSync(path.join(work, 'findings', 'circular-deps.json'), JSON.stringify({ status: 'ok', findings }, null, 2));
console.log(JSON.stringify({ packageCycles: findings.filter((f) => f.id.endsWith('package-cycle')).length, fileCycles: findings.filter((f) => f.id.endsWith('file-cycle')).length }));
EOF
node "${TMPDIR:-/tmp}/monorepo-doctor/cycles.mjs"
```

3. Review: for each cycle, open the import lines to confirm they are value imports. Drop false positives (e.g., an import inside a comment) before rendering.
4. If more than 20 file cycles exist in one package, keep the 20 shortest and add `"reason": "N file cycles; showing 20 shortest"` with status `partial`.
````

- [ ] **Step 2: Run against the generic fixture**

```bash
W="$(node -p 'require("os").tmpdir()')/monorepo-doctor"
node /tmp/mrd-detect.mjs fixtures/generic-pnpm && node "$W/scan.mjs"
node -e 'const t=require("fs").readFileSync("skills/monorepo-doctor/references/circular-deps.md","utf8");require("fs").writeFileSync(process.argv[1],t.match(/<<.EOF.\n([\s\S]*?)\nEOF/)[1])' "$W/cycles.mjs"
node "$W/cycles.mjs"
```
Expected: `{"packageCycles":1,"fileCycles":1}`.

- [ ] **Step 3: Commit**

```bash
git add skills/monorepo-doctor/references/circular-deps.md
git commit -m "feat(skill): add circular dependency check"
```

---
### Task 11: `references/caching.md` (Check 3)

**Files:**
- Create: `skills/monorepo-doctor/references/caching.md`

- [ ] **Step 1: Write the reference**

````markdown
# Check 3 — Task caching

Question: will a cache hit ever replay a wrong result, and are tasks re-running when they should hit?
Output: `findings/caching.json`. If no orchestrator is detected, only `caching/uncached-root-script` applies; set status `ok` with reason `no task orchestrator`.

## Facts the rules rely on

- **Turborepo**: a task with no `outputs` caches only logs — on a hit, `dist/` is NOT restored, so downstream tasks see stale or missing files. A package's hash covers its own files, its `package.json`, `turbo.json` and the lockfile; changes in workspace dependencies reach a task's hash **only** through `dependsOn` entries with `^` (e.g. `^build`). Env vars affect the hash only when listed in `env`, `globalEnv` (or `passThroughEnv` for runtime-only); framework prefixes such as `NEXT_PUBLIC_`, `VITE_` are auto-included.
- **Nx**: when `outputs` is omitted, Nx caches `{workspaceRoot}/dist/{projectRoot}`, `{projectRoot}/dist`, `{projectRoot}/build`, `{projectRoot}/public`. Env vars affect the hash only through an `{ "env": "NAME" }` entry in `inputs`. Without a `production` named input that excludes tests, editing a spec file invalidates the build cache.

## Rules

| id | severity | detect |
|---|---|---|
| `caching/missing-outputs` | high | **Turbo**: a cacheable task named `build`/`compile`/`bundle`/`*:build` (or whose package script runs `tsc`, `vite build`, `tsup`, `rollup`, `webpack`, `next build`, `esbuild`) has no `outputs`. Package-level `turbo.json` overrides count. **Nx**: cacheable build-like target without `outputs` whose real out dir (`outDir` in the build tsconfig, `outDir`/`--out-dir` flags, `build.outDir` in vite config) is not one of Nx's defaults — one finding per affected project, with `package`. Turbo findings are per task: `location.file: "turbo.json"`, no `package`. |
| `caching/build-inputs-include-tests` | medium | **Turbo**: build-like task has no `inputs`, or `inputs` that don't exclude test globs (`!**/*.test.*`, `!**/*.spec.*`, `!**/__tests__/**`). **Nx**: no `production` named input, or `build` inputs don't reference it, or `production` doesn't negate test globs. |
| `caching/undeclared-env` | medium | for each `scan.env` entry in a package with a cacheable build/test task: **Turbo**: name not matched by the task's `env`, `globalEnv` or `passThroughEnv` (`*` wildcards; `!` negation) and not framework-prefixed. **Nx**: no `{ "env": NAME }` in the target's inputs (resolve named inputs). Ignore `NODE_ENV`, `CI`, `PATH`, `HOME`, `TZ`, `PWD`. One finding per (package, name), listing up to 5 locations. |
| `caching/turbo-cache-disabled` | medium | Turbo task with `cache: false` that is not `persistent: true` and whose name isn't `dev`, `start`, `serve`, `watch`, `deploy`, `release`, `publish`, `clean`. |
| `caching/unstable-hash` | high | turbo installed: run `npx turbo run build --dry=json` twice; any task whose `hash` differs between runs. Report the task and the `inputs`/`environmentVariables` that differ. |
| `caching/volatile-input` | high | task `inputs` or `globalDependencies` include build artifacts or machine-local files: `dist`, `build`, `.turbo`, `.nx`, `*.tsbuildinfo`, `.env.local`, `**/*.log`, `node_modules`. |
| `caching/uncached-root-script` | low | a root `package.json` script that runs tasks across packages bypassing the orchestrator: `-r`/`--recursive`, `--workspaces`/`-ws`, `yarn workspaces foreach`, `lerna run`. In repos **without** an orchestrator, say "consider adding Nx or Turborepo" in `fix`. |

## Steps

1. Read `turbo.json` (and `<pkg>/turbo.json` overrides with `"extends": ["//"]`) and/or `nx.json` + every `project.json` / `package.json#nx`. For Nx, also read `targetDefaults` and `namedInputs`, and remember that Nx plugins (`plugins` in `nx.json`) can infer targets — if a target exists only via plugin inference, report rules that depend on its config as `partial` and say so.
2. Apply the rules above. Quote the exact JSON in `evidence` (task name + its config object). Config-level findings (Turbo tasks, Nx `targetDefaults`/`namedInputs`) omit `location.package`; only set `package` when the problem is specific to one package (e.g. its own `turbo.json`/`project.json`, or an env read in its source).
3. `unstable-hash` runs only when turbo is installed; otherwise mark the check `partial` with reason `turbo not installed; dry-run hash comparison skipped`. Never run real tasks — only `--dry=json`.
4. Write `findings/caching.json`.

## Fix guidance

- missing-outputs (Turbo): `"outputs": ["dist/**"]` (add `".next/**", "!.next/cache/**"` for Next.js).
- missing-outputs (Nx): `"outputs": ["{projectRoot}/lib"]` matching the real out dir.
- build-inputs-include-tests (Nx): `"namedInputs": { "production": ["default", "!{projectRoot}/**/*.spec.ts", "!{projectRoot}/**/*.test.ts"] }` and `"build": { "inputs": ["production", "^production"] }`.
- build-inputs-include-tests (Turbo): `"inputs": ["$TURBO_DEFAULT$", "!**/*.test.*", "!**/*.spec.*"]`.
- undeclared-env: Turbo `"env": ["API_URL"]`; Nx `"inputs": ["production", { "env": "API_URL" }]`.
````

- [ ] **Step 2: Verify ids** — `grep -o '`caching/[a-z-]*`' skills/monorepo-doctor/references/caching.md | sort -u | wc -l` → `7`.

- [ ] **Step 3: Commit**

```bash
git add skills/monorepo-doctor/references/caching.md
git commit -m "feat(skill): add caching check"
```

---

### Task 12: `references/ci-coverage.md` (Check 4)

**Files:**
- Create: `skills/monorepo-doctor/references/ci-coverage.md`

- [ ] **Step 1: Write the reference**

````markdown
# Check 4 — CI test coverage

Question: can a change land without the tests that cover it running in CI?
Inputs: `workspace.json` (`ciFiles`), `scan.json`. Output: `findings/ci-coverage.json`.

## Rules

| id | severity | detect |
|---|---|---|
| `ci-coverage/undeclared-workspace-dependency` | critical (medium when Nx is an orchestrator, since Nx infers edges from imports) | `scan.imports` entry with `declared: false` and `isTest: false`, importing package's `source` is `package.json`. Affected/filtered runs and `^` caching won't treat the importer as depending on the target, so changing the target skips the importer's tests. One finding per (from, target) pair. |
| `ci-coverage/missing-test-script` | high | package has `scan.packages[p].testFiles.length > 0` but `hasTestScript` is false and no test target exists (Nx: `nxTargets.test`, or an inferred test plugin in `nx.json#plugins` such as `@nx/vite/plugin`, `@nx/jest/plugin`, `@nx/vitest`). Its tests never run. |
| `ci-coverage/tests-not-run-in-ci` | high | no CI file matches `/\b(npm\|pnpm\|yarn\|bun\|npx\|nx\|turbo)\b[^\n]*\btest\b\|\b(vitest\|jest\|mocha)\b/`. If `ciFiles` is empty, report with `location.file: "(none)"` and evidence "no CI configuration found". |
| `ci-coverage/shallow-checkout-affected` | high | a GitHub Actions job runs `nx affected`, `turbo … --affected`, or `--filter=…[<ref>]`, uses `actions/checkout` and does **not** set `fetch-depth: 0` (default depth 1 makes the base ref unavailable → everything or nothing is "affected"). |
| `ci-coverage/nx-affected-base-missing` | high | `nx affected` in CI with no `--base`, no `nrwl/nx-set-shas` step, and no `NX_BASE` env. |
| `ci-coverage/nx-test-inputs-ignore-deps` | high | Nx `test` target (targetDefaults or project) is cacheable and its `inputs` have no `^`-prefixed entry — a change in a dependency replays a cached pass. |
| `ci-coverage/turbo-test-missing-dependson` | high | Turbo `test` (or `*:test`) task is cacheable and `dependsOn` has no `^` entry — dependency changes don't change the test hash, so a cached pass is replayed. |

## Steps

1. Read every file in `ciFiles`. For GitHub Actions, reason per job: a checkout step's `with.fetch-depth` applies to the steps after it in the same job.
2. Resolve Nx targets as in caching (targetDefaults merged with project config). Resolve Turbo tasks from `turbo.json` and package overrides.
3. Apply the rules; quote the CI step / config object as `evidence`.
4. Write `findings/ci-coverage.json`.

## Fix guidance

- undeclared-workspace-dependency: add `"<target>": "workspace:*"` (pnpm/yarn/bun) or `"*"` (npm) to the importer's dependencies, and import via the package name.
- shallow-checkout-affected: `with: { fetch-depth: 0 }` on `actions/checkout`.
- nx-affected-base-missing: add `- uses: nrwl/nx-set-shas@v4` before `nx affected`.
- nx-test-inputs-ignore-deps: `"test": { "inputs": ["default", "^production"] }`.
- turbo-test-missing-dependson: `"test": { "dependsOn": ["^build"] }` (or `["^test"]` when tests run on sources).
````

- [ ] **Step 2: Verify ids** — `grep -o '`ci-coverage/[a-z-]*`' skills/monorepo-doctor/references/ci-coverage.md | sort -u | wc -l` → `7`.

- [ ] **Step 3: Commit**

```bash
git add skills/monorepo-doctor/references/ci-coverage.md
git commit -m "feat(skill): add CI test coverage check"
```

---
### Task 13: `references/prod-leakage.md` (Check 5)

**Files:**
- Create: `skills/monorepo-doctor/references/prod-leakage.md`

- [ ] **Step 1: Write the reference**

````markdown
# Check 5 — Test code in production

Question: do test files, fixtures or test libraries end up in a published package or a deployable build?
Output: `findings/prod-leakage.json`.

Test file pattern (scan pattern plus fixture dirs): `/\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__|fixtures?)\//`.
Test libraries: `vitest`, `jest`, `@jest/*`, `mocha`, `chai`, `sinon`, `@testing-library/*`, `cypress`, `playwright`, `@playwright/test`, `msw`, `nock`, `supertest`, `ts-jest`, `@vitest/*`.

## Rules

| id | severity | detect |
|---|---|---|
| `prod-leakage/test-files-in-package` | critical | publishable package (`private !== true`) whose tarball contains test files. |
| `prod-leakage/test-files-in-build-output` | critical | a package's existing build output dir (`dist`, `build`, `lib`, or the tsconfig `outDir`) contains compiled test files (`*.spec.js`, `*.test.js`, `*.spec.d.ts`, …). Only check dirs that exist — never build. |
| `prod-leakage/build-tsconfig-includes-tests` | high | the build tsconfig `include`s the test files' location and its `exclude` doesn't match them. Build tsconfig = file passed via `-p`/`--project` in the `build` script, else `tsconfig.build.json`, else `tsconfig.lib.json`, else `tsconfig.json` when the build script is plain `tsc`. Skip packages with no build script. |
| `prod-leakage/test-lib-in-dependencies` | high (medium if `private`) | a test library appears in `dependencies` (not `devDependencies`). Consumers install it in production. |
| `prod-leakage/publint-issue` | error→high, warning→medium, suggestion→low | `publint` messages for publishable packages. |

## Steps

1. For each publishable package (non-private, `source: package.json`):
   ```bash
   (cd "<pkg-dir>" && npm pack --dry-run --json --ignore-scripts 2>/dev/null)
   ```
   Parse `[0].files[].path`; any match of the test pattern → `test-files-in-package` (list up to 10 in `evidence`).
   If `npm pack` fails (e.g. `workspace:` protocol under npm), fall back to reasoning: if the package has no `files` field and no `.npmignore`, every file not in `.gitignore` ships — compare against `scan.packages[p].testFiles`. If `files` is present, test files ship only if a `files` entry matches them. State in `evidence` that the fallback was used.
2. Check existing build output dirs for compiled test files.
3. Resolve each package's build tsconfig and check `include`/`exclude` against `scan.packages[p].testFiles`. Treat `include: ["src"]` as `src/**/*`. Follow `extends` one level for `include`/`exclude` when the file itself has none.
4. Check `dependencies` against the test-library list.
5. If `hasNodeModules`, for each publishable package that has its build output present:
   ```bash
   npx --yes publint "<pkg-dir>" 2>&1
   ```
   publint prints sections `Errors:`, `Warnings:`, `Suggestions:` followed by numbered messages. One finding per message. Skip unbuilt packages and set status `partial` with reason `publint skipped for unbuilt packages: …`.
6. Write `findings/prod-leakage.json`.

## Fix guidance

- test-files-in-package: add `"files": ["dist"]` to package.json (preferred over `.npmignore`).
- build-tsconfig-includes-tests: `"exclude": ["**/*.spec.ts", "**/*.test.ts", "**/__tests__/**"]`.
- test-lib-in-dependencies: move it to `devDependencies`.
````

- [ ] **Step 2: Verify ids** — `grep -o '`prod-leakage/[a-z-]*`' skills/monorepo-doctor/references/prod-leakage.md | sort -u | wc -l` → `5`.

- [ ] **Step 3: Commit**

```bash
git add skills/monorepo-doctor/references/prod-leakage.md
git commit -m "feat(skill): add production test-leakage check"
```

---

### Task 14: `SKILL.md`

**Files:**
- Create: `skills/monorepo-doctor/SKILL.md`

- [ ] **Step 1: Write the skill**

````markdown
---
name: monorepo-doctor
description: Use when auditing a JavaScript/TypeScript monorepo (npm, yarn, pnpm or bun workspaces, Nx, Turborepo) for poorly split packages, circular dependencies, misconfigured task caching, tests that silently skip in CI, or test code shipped to production. Read-only; writes a Markdown and JSON report.
---

# Monorepo Doctor

Audit a JS/TS monorepo for five classes of problems that teams routinely miss, and produce an evidence-backed report.

## Rules

- **Read-only.** Never install dependencies, build, run tests, or edit project files. Allowed writes: `monorepo-doctor-report.md`, `monorepo-doctor-report.json` (workspace root or a user-given dir) and `$TMPDIR/monorepo-doctor/`.
- Allowed commands: the snippets in the reference files, `npx --yes knip|publint`, `npm pack --dry-run`, and `npx nx` / `npx turbo` **only if** detection reports them `installed` (graph / `--dry=json` / `boundaries` only — never real task runs).
- **Never abort a check.** If a tool fails, mark the check `partial` or `skipped` with a reason and continue.
- **Every finding needs evidence** (config snippet, file:line, or command output). No evidence → no finding.
- Use only the finding ids defined in the reference files.

## Workflow

1. **Detect** — follow [references/detection.md](references/detection.md). Stop if `NO_WORKSPACE`.
2. **Scan** — follow [references/scan.md](references/scan.md).
3. **Check** — run all five unless the user asked for a subset (write `{"status":"not-run","reason":"not requested","findings":[]}` for the others):
   - [references/boundaries.md](references/boundaries.md) — package split & public API
   - [references/circular-deps.md](references/circular-deps.md) — package and file cycles
   - [references/caching.md](references/caching.md) — Nx / Turborepo cache correctness
   - [references/ci-coverage.md](references/ci-coverage.md) — tests that silently don't run in CI
   - [references/prod-leakage.md](references/prod-leakage.md) — test code shipped to production
   The checks are independent; if you can run sub-agents, run them in parallel.
4. **Report** — follow [references/report-format.md](references/report-format.md): validate each `findings/<check>.json`, render, then show the user the summary line and the top 5 findings.
5. **CI mode** (only if asked, or when invoked non-interactively with a threshold) — run the exit-code snippet from report-format.md.

## Tracking

Create a todo per phase/check and mark each done as its findings file is written.
````

- [ ] **Step 2: Run the linter** — `npm run check` → Expected: `✓ skill is consistent`. If it reports an expected id not defined in any reference, fix the reference (ids must appear in backticks).

- [ ] **Step 3: Run tests** — `npm test` → all pass.

- [ ] **Step 4: Commit**

```bash
git add skills/monorepo-doctor/SKILL.md
git commit -m "feat(skill): add SKILL.md entry point"
```

---

### Task 15: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README** with these sections (complete prose, no placeholders):
  1. **Title + one-line pitch**: "An agent skill that audits JS/TS monorepos for the five problems teams keep missing."
  2. **What it checks**: a table with the five checks, one-sentence description each, and example finding ids.
  3. **Supported workspaces**: npm/yarn/pnpm/bun workspaces; extra rules for Nx and Turborepo.
  4. **Install**:
     ```bash
     npx skills add santoshyadavdev/monorepo-doctor
     ```
     Manual: copy `skills/monorepo-doctor` to `~/.claude/skills/` (Claude Code) or `~/.copilot/skills/` (Copilot CLI) or `.github/skills/` in a repo.
  5. **Use**: example prompts — "Run monorepo-doctor on this repo", "Audit only caching and CI coverage", "Run monorepo-doctor in CI mode, fail on high".
  6. **Output**: describe `monorepo-doctor-report.md` / `.json`, the severity rubric, and paste a short sample of the Markdown report.
  7. **Guarantees**: read-only; which commands it may run; what's skipped without `node_modules` or without a local `nx`/`turbo`.
  8. **CI example**: a GitHub Actions job that runs an agent CLI with the skill in non-interactive mode and uploads the report as an artifact (mark the agent CLI step as "adapt to your agent").
  9. **Prior art**: Nx agent skills, Turborepo skill, madge, dependency-cruiser, knip, publint, `@nx/enforce-module-boundaries`, `turbo boundaries` — and what this adds (one audit across all five concerns).
  10. **Development**: `npm test`, `npm run check`, fixtures + `scripts/verify-fixture.mjs`.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

### Task 16: End-to-end validation against fixtures

Run the actual skill (as an agent would) against each fixture and verify the report. Runs are **sequential** because they share `$TMPDIR/monorepo-doctor/`.

- [ ] **Step 1: For each fixture** in `generic-pnpm`, `nx`, `turborepo`, dispatch a fresh subagent with this prompt (substitute `<fixture>`):

> You have a skill at `<repo>/skills/monorepo-doctor/SKILL.md`. Read it and follow it exactly to audit the monorepo at `<repo>/fixtures/<fixture>`. Write the reports to `$TMPDIR/mrd-out/<fixture>/` (create the directory). Do not modify anything under `fixtures/`. When finished, reply with the summary line and the list of finding ids with packages.

- [ ] **Step 2: Verify each report**

```bash
OUT="$(node -p 'require("os").tmpdir()')/mrd-out"
for f in generic-pnpm nx turborepo; do
  echo "== $f"; node scripts/verify-fixture.mjs "$OUT/$f/monorepo-doctor-report.json" "fixtures/expected/$f.json"
done
git status --porcelain fixtures   # must be empty
```
Expected: `✓ fixture report matches expectations` three times; no changes under `fixtures/`.

- [ ] **Step 3: Fix gaps.** For every `✗ missing` or `✗ clean package flagged`, find which reference step was ambiguous or wrong, fix **the reference** (not the fixture, unless the fixture doesn't actually contain the seeded issue), and re-run that fixture. Repeat until all three pass. Run `npm test && npm run check` after edits.

- [ ] **Step 4: Commit**

```bash
git add -A skills
git commit -m "fix(skill): tighten references after end-to-end fixture runs"
```
(Skip if no changes.)

---

## Self-review checklist (done while writing this plan)

- Spec coverage: five checks ✔ (Tasks 9–13), detection ✔ (7), report + JSON + severity + CI mode ✔ (6), generic + Nx + Turbo ✔ (fixtures 3–5, orchestrator rules in 9, 11, 12), read-only guarantee ✔ (14), install via `npx skills add` ✔ (15), fixture-based testing ✔ (1, 16).
- Spec deviations (recorded in the spec's "Implementation notes"): `npx --yes`; nx/turbo only if installed; shared `scan.md`; built-in file-cycle detection instead of madge; `build-inputs-include-tests` lives under caching; added `test-files-in-build-output`; `not-run` status; render snippet; `test-inputs-incomplete` renamed `nx-test-inputs-ignore-deps`.
- Id consistency: catalog table = ids in Tasks 9–13 = ids in `fixtures/expected/*.json`; enforced by `npm run check`.
