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
