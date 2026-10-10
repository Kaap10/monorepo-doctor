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
