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
