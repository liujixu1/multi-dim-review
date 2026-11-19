import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DIMENSIONS,
  LINE_TOLERANCE,
  PromptMissing,
  buildDiffText,
  countHunks,
  dedupe,
  extractJson,
  loadPrompt,
  normalizeFindings,
  normalizePath,
  parseDiff,
  parseFailOn,
  resolveModel,
  shouldSkip,
  sortFindings,
  truncateAtHunkBoundary,
  verifyFindings,
} from '../scripts/review.mjs'

const SAMPLE_DIFF = `diff --git a/backend/src/Chat.java b/backend/src/Chat.java
--- a/backend/src/Chat.java
+++ b/backend/src/Chat.java
@@ -10,0 +11,3 @@
+    public void ask() {
+        runAsync(task);
+    }
diff --git a/frontend/src/api/http.ts b/frontend/src/api/http.ts
--- a/frontend/src/api/http.ts
+++ b/frontend/src/api/http.ts
@@ -20,0 +21,1 @@
+export const client = axios.create({ baseURL: '/api' })
diff --git a/frontend/pnpm-lock.yaml b/frontend/pnpm-lock.yaml
--- a/frontend/pnpm-lock.yaml
+++ b/frontend/pnpm-lock.yaml
@@ -1,0 +2,1 @@
+    resolution: {integrity: sha512-xxx}
`

const byPath = (files) => new Map(files.map((f) => [f.path, f]))

test('parseDiff 记录新增行号', () => {
  const files = byPath(parseDiff(SAMPLE_DIFF))
  assert.deepEqual(
    [...files.keys()].sort(),
    ['backend/src/Chat.java', 'frontend/pnpm-lock.yaml', 'frontend/src/api/http.ts'],
  )
  // 新增行在新文件侧第 11、12、13 行
  assert.deepEqual([...files.get('backend/src/Chat.java').added].sort((a, b) => a - b), [11, 12, 13])
  assert.deepEqual([...files.get('frontend/src/api/http.ts').added], [21])
})

test('锁文件被跳过，源码不跳过', () => {
  const kept = parseDiff(SAMPLE_DIFF)
    .map((f) => f.path)
    .filter((p) => !shouldSkip(p))
  assert.ok(!kept.includes('frontend/pnpm-lock.yaml'))
  assert.ok(kept.includes('backend/src/Chat.java'))
})

test('纯删除文件不产生评审目标', () => {
  const diff = `diff --git a/old.java b/old.java
--- a/old.java
+++ /dev/null
@@ -1,2 +0,0 @@
-void a() {}
-void b() {}
`
  assert.deepEqual(parseDiff(diff), [])
})

test('编造的行号被降级且无法阻断', () => {
  const files = byPath(parseDiff(SAMPLE_DIFF))
  const findings = normalizeFindings(
    {
      findings: [
        { file: 'backend/src/Chat.java', line: 12, severity: 'high', title: '真实位置' },
        { file: 'backend/src/Chat.java', line: 999, severity: 'blocker', title: '编造行号' },
        { file: 'backend/src/NotExist.java', line: 1, severity: 'blocker', title: '编造文件' },
      ],
    },
    'logic',
  )
  verifyFindings(findings, files)

  const real = findings.find((f) => f.title === '真实位置')
  const fakeLine = findings.find((f) => f.title === '编造行号')
  const fakeFile = findings.find((f) => f.title === '编造文件')

  assert.equal(real.verified, true)
  assert.equal(real.severity, 'high')
  assert.equal(fakeLine.verified, false)
  assert.equal(fakeLine.severity, 'low')
  assert.equal(fakeFile.verified, false)
  assert.equal(fakeFile.severity, 'low')
})

test('dimension 由编排器强制写入', () => {
  const findings = normalizeFindings(
    { findings: [{ file: 'a.ts', line: 1, severity: 'low', dimension: 'security', title: 't' }] },
    'arch',
  )
  assert.equal(findings[0].dimension, 'arch')
})

test('严重等级近义词被归一', () => {
  const cases = [
    ['critical', 'blocker'],
    ['MAJOR', 'high'],
    ['nit', 'low'],
    ['', 'medium'],
    ['不认识的等级', 'medium'],
  ]
  for (const [raw, expected] of cases) {
    const findings = normalizeFindings(
      { findings: [{ file: 'a.ts', line: 1, severity: raw, title: 't' }] },
      'logic',
    )
    assert.equal(findings[0].severity, expected, `severity=${raw}`)
  }
})

test('extractJson 容忍围栏与前后说明', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"findings": []}\n```\n希望有帮助'), { findings: [] })
  assert.deepEqual(extractJson('前言 {"findings": []} 后记'), { findings: [] })
})

test('extractJson 对垃圾输入报错', () => {
  assert.throws(() => extractJson('完全没有 JSON'), /找不到 JSON/)
})

test('extractJson 容忍 JSON 后的花括号文本', () => {
  const text = '{"findings":[]}\n\n说明：位置写作 {file}:{line}'
  assert.deepEqual(extractJson(text), { findings: [] })
})

test('extractJson 在多个对象中选含 findings 的那个', () => {
  const text = '{"note":"先说明"}\n然后：\n{"findings":[{"file":"a","line":1,"severity":"low","title":"t"}]}'
  const parsed = extractJson(text)
  assert.ok('findings' in parsed && parsed.findings.length)
})

test('dedupe 在标题更长的 medium 与短标题 blocker 之间保留 blocker', () => {
  const out = dedupe([
    { dimension: 'logic', file: 'a.ts', line: 5, severity: 'blocker', title: '空指针', detail: '会 NPE' },
    { dimension: 'logic', file: 'a.ts', line: 5, severity: 'medium', title: '建议对该分支补充空值保护以便后续维护者阅读', detail: 'd' },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].severity, 'blocker')
})

test('dedupe 不合并不同维度', () => {
  const out = dedupe([
    { dimension: 'logic', file: 'a.ts', line: 5, severity: 'high', title: 'A' },
    { dimension: 'security', file: 'a.ts', line: 5, severity: 'high', title: 'B' },
  ])
  assert.equal(out.length, 2)
})

test('parseFailOn 支持近义词与 none', () => {
  assert.deepEqual([...parseFailOn('blocker,high')], ['blocker', 'high'])
  assert.deepEqual([...parseFailOn('critical')], ['blocker'])
  assert.equal(parseFailOn('none').size, 0)
})

test('parseFailOn 拒绝未知等级', () => {
  assert.throws(() => parseFailOn('blocker,whatever'), /未知等级/)
})

test('budget：丢弃项被记录，且后续小文件仍进入', () => {
  const big = { path: 'big.ts', text: 'x'.repeat(500), added: new Set([1]) }
  const small = { path: 'small.sql', text: '+select 1;', added: new Set([1]) }
  const { text, included, dropped } = buildDiffText([big, small], 200, 1000)

  assert.ok(text.includes('select 1') || included.includes('small.sql'))
  assert.ok(dropped.includes('big.ts'))
  assert.ok(included.includes('small.sql'))
})

test('预算：included + dropped 等于输入总数', () => {
  const files = parseDiff(SAMPLE_DIFF)
  const { included, dropped, text } = buildDiffText(files, 120, 100)
  assert.ok(text.length <= 300)
  assert.equal(included.length + dropped.length, files.length)
})

test('truncateAtHunkBoundary 保留文件头并提示剩余 hunk', () => {
  const body =
    'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n' +
    '@@ -1,0 +2,40 @@\n' + Array.from({ length: 40 }, (_, i) => `+line${i}`).join('\n') + '\n' +
    '@@ -100,0 +102,40 @@\n' + Array.from({ length: 40 }, (_, i) => `+more${i}`).join('\n') + '\n'
  const out = truncateAtHunkBoundary(body, 300)
  assert.ok(out.includes('diff --git'))
  assert.ok(out.includes('未展示'))
  assert.ok(countHunks(out) < countHunks(body))
})

// --- 以下为修复回归 -------------------------------------------------------

test('回归：diff 文本保留文件边界', () => {
  const raw =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,0 +11,2 @@\n+const a = 1\n+const b = 2\n' +
    'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -10,0 +11,2 @@\n+const c = 3\n+const d = 4\n'
  const files = parseDiff(raw)
  const { text, included } = buildDiffText(files, 1e9, 1e9)

  assert.ok(text.includes('diff --git a/a.ts b/a.ts'))
  assert.ok(text.includes('diff --git a/b.ts b/b.ts'))
  assert.ok(text.includes('+++ b/a.ts') && text.includes('+++ b/b.ts'))
  // 两个文件的 hunk 头文本相同，只能靠文件头区分
  assert.equal(files[0].text.split('\n')[3], files[1].text.split('\n')[3])
  assert.deepEqual(included, ['a.ts', 'b.ts'])
})

test('回归：路径保留前导点，且只剥一个前缀', () => {
  assert.equal(normalizePath('b/.gitignore'), '.gitignore')
  assert.equal(normalizePath('b/.github/workflows/x.yml'), '.github/workflows/x.yml')
  assert.equal(normalizePath('.cursor/rules/x.mdc'), '.cursor/rules/x.mdc')
  // -no-prefix 风格的 a/b/c.ts 不能变成 c.ts
  assert.equal(normalizePath('a/b/c.ts'), 'b/c.ts')
})

test('回归：点目录被真正跳过', () => {
  for (const path of ['.venv/lib/x.py', '.pytest_cache/x', '.ruff_cache/y.py', '.git/config']) {
    const parsed = parseDiff(
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +2,1 @@\n+x\n`,
    )
    assert.equal(parsed.length, 1)
    assert.equal(shouldSkip(parsed[0].path), true, `${path} 未被过滤`)
  }
})

test('回归：新增行以 "++ " 开头时不误判为文件头', () => {
  const raw =
    'diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n' +
    '@@ -1,2 +1,3 @@\n select 1;\n+++ b/not-a-header\n select 3;\n'
  const files = parseDiff(raw)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'q.sql')
  assert.ok(files[0].text.includes('not-a-header'))
})

test('多 hunk 行号累计', () => {
  const raw =
    'diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n' +
    '@@ -5,3 +5,4 @@\n a\n+b\n c\n d\n' +
    '@@ -50,2 +51,3 @@\n e\n+f\n g\n'
  const f = parseDiff(raw)[0]
  assert.deepEqual([...f.added].sort((a, b) => a - b), [6, 52])
})

test('\\ No newline at end of file 不占行号', () => {
  const raw =
    'diff --git a/z.txt b/z.txt\n--- a/z.txt\n+++ b/z.txt\n' +
    '@@ -1,1 +1,2 @@\n x\n+y\n\\ No newline at end of file\n'
  const f = parseDiff(raw)[0]
  assert.deepEqual([...f.added], [2])
})

test('纯重命名不产生评审目标', () => {
  const raw = 'diff --git a/old.py b/new.py\nsimilarity index 100%\nrename from old.py\nrename to new.py\n'
  assert.deepEqual(parseDiff(raw), [])
})

test('promptDir 被真正采用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'air-'))
  for (const dim of DIMENSIONS) {
    writeFileSync(join(dir, `${dim}.md`), `来自基线分支的 ${dim} 提示词`, 'utf8')
  }
  assert.ok(loadPrompt('security', dir).includes('来自基线分支'))
  // 不传时读仓库内默认目录
  assert.ok(loadPrompt('security').toLowerCase().includes('diff'))
})

test('缺提示词抛 PromptMissing', () => {
  assert.throws(() => loadPrompt('security', '/nonexistent-dir-xyz'), PromptMissing)
})

test('resolveModel 不回落硬编码模型名', () => {
  assert.equal(resolveModel('security', null, {}), '')
  assert.equal(resolveModel('security', null, { AI_REVIEW_MODEL_SECURITY: 'strong', AI_REVIEW_MODEL: 'weak' }), 'strong')
  assert.equal(resolveModel('arch', null, { AI_REVIEW_MODEL_SECURITY: 'strong', AI_REVIEW_MODEL: 'weak' }), 'weak')
})

test('LINE_TOLERANCE 语义：±3 内算已验证，超出降级', () => {
  const files = new Map([
    ['a.py', { path: 'a.py', text: '', added: new Set([11]) }],
  ])
  const mk = (line) => ({
    dimension: 'logic', file: 'a.py', line, severity: 'blocker', title: 't', detail: '', suggestion: '', verified: false,
  })

  for (const line of [11 - LINE_TOLERANCE, 11, 11 + LINE_TOLERANCE]) {
    const f = mk(line)
    verifyFindings(files ? [f] : [], files)
    assert.equal(f.verified, true, `line=${line} 应验证通过`)
  }

  const beyond = mk(11 + LINE_TOLERANCE + 1)
  verifyFindings([beyond], files)
  assert.equal(beyond.verified, false)
  assert.equal(beyond.severity, 'low')
})

test('sortFindings 让已验证项排在前，同级按维度序', () => {
  const out = sortFindings([
    { dimension: 'arch', file: 'b.ts', line: 1, severity: 'high', verified: false },
    { dimension: 'security', file: 'a.ts', line: 9, severity: 'high', verified: true },
    { dimension: 'logic', file: 'c.ts', line: 2, severity: 'blocker', verified: true },
  ])
  assert.equal(out[0].verified, true)
  assert.equal(out[0].severity, 'blocker')
  assert.equal(out[out.length - 1].verified, false)
})

test('所有维度提示词都存在且要求 JSON', () => {
  for (const dim of DIMENSIONS) {
    const text = loadPrompt(dim)
    assert.ok(text.includes('"findings"'), `${dim} 未要求输出 findings`)
    assert.ok(text.toLowerCase().includes('diff'), `${dim} 未提及 diff`)
  }
})
