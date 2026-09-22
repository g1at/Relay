'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
// The private audit bundle stays local. A source checkout can run every code
// test without it; a partially present bundle must still fail validation.
const auditEntrypoints = [
  'docs/sdk-evaluation-0.3.266.json',
  'docs/sdk-high-priority-implementation.json',
  'docs/sdk-adoption-implementation.json',
  'docs/sdk-medium-implementation.json',
  'docs/Relay-SDK-0.3.266-逐项评估.html',
  'docs/Relay-SDK-0.3.266-逐项评估.md',
];
if (!auditEntrypoints.some(file => fs.existsSync(path.join(root, file)))) {
  test('local SDK audit documents and retained evidence', {
    skip: 'Local docs/ audit bundle is not included in the source checkout.',
  }, () => {});
} else {
const report = JSON.parse(read('docs/sdk-evaluation-0.3.266.json'));
const implementation = JSON.parse(read('docs/sdk-high-priority-implementation.json'));
const adoption = JSON.parse(read('docs/sdk-adoption-implementation.json'));
const medium = JSON.parse(read('docs/sdk-medium-implementation.json'));
const html = read('docs/Relay-SDK-0.3.266-逐项评估.html');
const markdown = read('docs/Relay-SDK-0.3.266-逐项评估.md');
const rows = new Map(report.rows.map(row => [row.id, row]));
const high = report.rows.filter(row => row.priority === '高');
const markdownCells = line => line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());

test('SDK evaluation retains all 673 unique rows and 361 declared exports against the installed declaration baseline', () => {
  assert.equal(report.sdkVersion, '0.3.266'); assert.equal(report.rows.length, 673); assert.equal(rows.size, 673);
  assert.equal(report.exportIndex.length, 361);
  assert.equal(new Set(report.exportIndex.map(item => `${item.file}:${item.name}`)).size, 361);
  assert.equal(report.stats.rows, 673); assert.equal(report.stats.allEntrypointExportedDeclarations, 361);
  assert.equal(report.stats.allDeclaredCoverageMatched, true);
  for (const item of report.exportIndex) {
    assert.ok(item.ownerRows.length > 0, `${item.name} must have an evaluated owner`);
    for (const owner of item.ownerRows) assert.ok(rows.has(owner), `${item.name} maps to missing row ${owner}`);
  }
  for (const [file, expected] of Object.entries(report.declarationSha256)) {
    const actual = crypto.createHash('sha256').update(read(`node_modules/@anthropic-ai/claude-agent-sdk/${file}`)).digest('hex');
    assert.equal(actual, expected, `${file} changed; update the audit rather than carrying stale coverage forward`);
  }
});

test('all 47 high-priority rows map exactly once to 43 implemented and four upstream-limited results', () => {
  assert.equal(high.length, 47); assert.equal(report.stats.highPriorityCovered, 47);
  const counts = high.reduce((result, row) => {
    const status = row.implementation?.status; result[status] = (result[status] || 0) + 1; return result;
  }, {});
  assert.deepEqual(counts, { '已落实': 43, '已接入·上游限制': 4 });
  assert.deepEqual(report.stats.highPriorityImplementation, counts);
  const owned = implementation.workPackages.flatMap(work => work.rows);
  assert.equal(new Set(owned).size, 47); assert.equal(owned.length, 47);
  assert.deepEqual([...owned].sort(), high.map(row => row.id).sort());
  for (const work of implementation.workPackages) for (const id of work.rows) {
    const item = rows.get(id).implementation;
    assert.equal(item.workPackage, work.id, id);
    for (const field of ['status', 'summary', 'validation', 'limit']) assert.equal(item[field], work[field], `${id}:${field}`);
    assert.ok(item.evidence.length > 0, `${id} needs implementation evidence`);
  }
  assert.deepEqual(report.implementation, implementation);
  assert.deepEqual(high.filter(row => row.implementation.status.includes('限制')).map(row => row.id).sort(),
    ['06-022', '10-034', '13-015', '22-035']);
});

test('HTML embeds the complete identical evaluated dataset, including implementation limits and export mapping', () => {
  const embedded = html.match(/<script\s+id="report-data"\s+type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(embedded, 'HTML report needs its independently usable full data payload');
  assert.deepEqual(JSON.parse(embedded[1]), report);
  assert.match(html, /implementationHtml/);
  assert.match(html, /row\.implementation\?\.status/);
});

test('all eight remaining SDK adoption rows are implemented without replacing the earlier 47 receipts', () => {
  const expected = ['02-008', '02-009', '02-013', '03-003', '03-028', '06-019', '06-054', '22-031'];
  const ids = adoption.workPackages.flatMap(work => work.rows);
  assert.deepEqual([...ids].sort(), expected); assert.equal(new Set(ids).size, 8);
  assert.deepEqual(report.sdkAdoption, adoption); assert.equal(report.stats.sdkAdoptionCovered, 8);
  assert.equal(report.stats.totalImplementedRows, 161);
  for (const work of adoption.workPackages) for (const id of work.rows) {
    const row = rows.get(id); assert.equal(row.recommendation, '接入SDK');
    assert.equal(row.implementation.status, '已落实');
    for (const field of ['status', 'summary', 'validation', 'limit']) assert.equal(row.implementation[field], work[field], id);
  }
  const selected = report.rows.filter(row => row.recommendation === '接入SDK');
  assert.equal(selected.length, 12); assert.ok(selected.every(row => row.implementation.status === '已落实'));
  assert.match(html, /data-view="adoption"/); assert.match(html, /adoptionOnly/);
  assert.match(markdown, /本轮建议接入 SDK 的 8 条落实状态/);
});

test('Markdown carries every row once with the exact implementation state shown in JSON and HTML', () => {
  const tableRows = markdown.split('\n').filter(line => /^\| \d{2}-\d{3} · /.test(line));
  assert.equal(tableRows.length, 673);
  const seen = new Set();
  for (const line of tableRows) {
    const cells = markdownCells(line), id = cells[0].slice(0, 6);
    assert.ok(rows.has(id), `unexpected Markdown row ${id}`); assert.equal(seen.has(id), false, `duplicate Markdown row ${id}`); seen.add(id);
    const status = rows.get(id).implementation.status;
    assert.equal(cells[3].split('<br>')[0], status, `Markdown implementation status ${id}`);
    if (rows.get(id).implementation.status !== '未纳入本轮') {
      assert.match(cells[3], /验证：/, `${id} lacks validation`);
      assert.match(cells[3], /边界：/, `${id} lacks the implementation boundary`);
    }
  }
  assert.match(markdown, /43 条已落实，4 条/);
});

test('Markdown export index retains all 361 exported names and their declaration origins', () => {
  const start = markdown.indexOf('## 全入口导出名称索引');
  assert.ok(start > 0);
  const entries = markdown.slice(start).split('\n').filter(line => /^\| [^|]+ \| (?:type|class|interface|function|const|enum|namespace) \|/.test(line));
  assert.equal(entries.length, 361);
  const names = new Set(entries.map(line => {
    const cells = markdownCells(line), evidence = cells[4].match(/\[([^\]]+\.d\.ts):\d+\]/);
    assert.ok(evidence, `missing declaration origin ${cells[0]}`); return `${evidence[1]}:${cells[0]}`;
  }));
  assert.deepEqual([...names].sort(), report.exportIndex.map(item => `${item.file}:${item.name}`).sort());
});

test('published implementation evidence resolves locally and retained runtime receipts explicitly pass', () => {
  // These retained receipts describe the original source layout, not the new
  // implementation. Preserve their source and line references in a local-only
  // archive instead of silently redirecting old line numbers to moved code.
  const baselineRoot = path.join(root, 'docs/sdk-evaluation-source-baseline');
  const manifestPath = path.join(baselineRoot, 'manifest.json');
  const baseline = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  if (baseline) {
    assert.equal(baseline.commit, 'c663ec1609b6b9d53846678dca33e6d08b3e2879');
    assert.match(baseline.scope, /Historical source/);
    for (const [file, hash] of Object.entries(baseline.files)) {
      const target = path.resolve(baselineRoot, 'source', file);
      assert.ok(target.startsWith(path.join(baselineRoot, 'source') + path.sep), `baseline escapes archive: ${file}`);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), hash, file);
    }
  }
  const evidence = report.rows.flatMap(row => row.implementation.evidence || []);
  for (const item of evidence) {
    const repositoryTarget = path.resolve(root, item.path);
    assert.ok(repositoryTarget.startsWith(root + path.sep), `evidence escapes repository: ${item.path}`);
    const archivedSource = baseline && !item.path.startsWith('docs/');
    if (archivedSource) assert.ok(Object.hasOwn(baseline.files, item.path), `source missing from historical archive: ${item.path}`);
    const target = archivedSource ? path.join(baselineRoot, 'source', item.path) : repositoryTarget;
    assert.ok(fs.statSync(target).isFile(), item.path);
    assert.ok(Number.isSafeInteger(item.line) && item.line > 0, `${item.path} needs a positive source line`);
    assert.ok(item.line <= fs.readFileSync(target, 'utf8').split('\n').length, `${item.path}:${item.line} is out of range`);
  }
  const receipts = fs.readdirSync(path.join(root, 'docs/sdk-high-priority-evidence')).filter(file => file.endsWith('.json'));
  assert.ok(receipts.length >= 8, 'retain the Windows/Linux SDK and isolated renderer receipts');
  for (const file of receipts) {
    const receipt = JSON.parse(read(`docs/sdk-high-priority-evidence/${file}`));
    assert.equal(receipt.ok, true, file); assert.deepEqual(receipt.errors || [], [], file);
    if (file === 'regression.json') {
      assert.equal(receipt.passedFiles, receipt.testFiles); assert.equal(receipt.failedFiles, 0);
      assert.ok(receipt.testFiles >= 126); continue;
    }
    assert.ok(Object.keys(receipt.checks).length > 0, `${file} lacks check results`);
    if (Array.isArray(receipt.checks)) {
      // Runtime probes retain a successful assertion list; renderer probes
      // retain named booleans. Both also carry an explicit overall receipt.
      for (const value of receipt.checks) assert.ok(typeof value === 'string' && value.trim(), `${file} has an empty assertion`);
    } else for (const [name, value] of Object.entries(receipt.checks)) assert.equal(value, true, `${file}:${name}`);
    assert.match(receipt.scope, /隔离|临时配置/);
  }
});

test('SDK adoption runtime evidence is local, successful and explicitly isolated', () => {
  const receipts = fs.readdirSync(path.join(root, 'docs/sdk-adoption-evidence')).filter(file => file.endsWith('.json'));
  assert.ok(receipts.length >= 7);
  for (const file of receipts) {
    const receipt = JSON.parse(read(`docs/sdk-adoption-evidence/${file}`));
    assert.equal(receipt.ok, true, file); assert.deepEqual(receipt.errors || [], [], file);
    assert.match(receipt.scope, /隔离|临时/); assert.ok(Object.keys(receipt.checks).length > 0);
    if (Array.isArray(receipt.checks)) assert.ok(receipt.checks.every(value => typeof value === 'string' && value.trim()));
    else assert.ok(Object.values(receipt.checks).every(value => value === true));
  }
});

test('all 106 medium hybrid rows map exactly once to 104 implementations and two upstream tool restrictions', () => {
  const selected=report.rows.filter(row=>row.recommendation==='混合接入'&&row.priority==='中'), ids=medium.workPackages.flatMap(work=>work.rows);
  assert.equal(selected.length,106);assert.equal(ids.length,106);assert.equal(new Set(ids).size,106);
  assert.deepEqual([...ids].sort(),selected.map(row=>row.id).sort());assert.deepEqual(report.sdkMedium,medium);
  assert.equal(report.stats.mediumHybridCovered,106);assert.deepEqual(report.stats.mediumHybridImplementation,{'已落实':104,'已接入·上游限制':2});
  assert.equal(medium.workPackages.length,29);
  for(const work of medium.workPackages)for(const id of work.rows){
    assert.equal(rows.get(id).implementation.workPackage,work.id);
    for(const field of ['status','summary','validation','limit'])assert.equal(rows.get(id).implementation[field],work[field],id+':'+field);
    assert.ok(rows.get(id).implementation.evidence.length>0);
  }
  assert.deepEqual(selected.filter(row=>row.implementation.status.includes('限制')).map(row=>row.id).sort(),['16-040','16-041']);
  assert.ok(selected.every(row=>!/^Browser远程|Bridge/.test(row.group)&&!/^Cron/.test(row.key)));
  assert.match(html,/data-view="medium"/);assert.match(html,/mediumOnly/);assert.match(markdown,/本轮混合接入、中优先级的 106 条落实状态/);
});
test('medium integration receipts preserve the actual validation boundaries and all pass', () => {
  const receipts=fs.readdirSync(path.join(root,'docs/sdk-medium-evidence')).filter(file=>file.endsWith('.json'));assert.ok(receipts.length>=4);
  for(const file of receipts){const r=JSON.parse(read('docs/sdk-medium-evidence/'+file));assert.equal(r.ok,true,file);assert.deepEqual(r.errors||[],[],file);assert.match(r.scope,/隔离|临时/);assert.ok(Object.keys(r.checks).length>0,file);}
  const runtime=JSON.parse(read('docs/sdk-medium-evidence/runtime-windows.json'));
  assert.ok(runtime.nativeTools.includes('ReportFindings'));assert.ok(runtime.postTools.includes('EnterWorktree'));assert.ok(runtime.postTools.includes('ExitWorktree'));
  assert.equal(runtime.nativeTools.includes('ProposeSkills'),false);assert.equal(runtime.nativeTools.includes('ProposeGoal'),false);
});
}
