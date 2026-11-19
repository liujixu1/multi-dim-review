import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REVIEW = join(HERE, '..', 'scripts', 'review.mjs')

const DIFF = `diff --git a/backend/src/chat/ChatService.java b/backend/src/chat/ChatService.java
--- a/backend/src/chat/ChatService.java
+++ b/backend/src/chat/ChatService.java
@@ -40,0 +41,2 @@
+        String sql = "SELECT * FROM documents WHERE dept = '" + dept + "'";
+        return jdbc.queryForList(sql);
`

// 按维度返回不同结果，用来验证「维度隔离」与「严重度归一」
const RESPONSES = {
  security: {
    findings: [
      {
        file: 'backend/src/chat/ChatService.java',
        line: 41,
        severity: 'critical', // 用近义词考验归一化
        title: 'SQL 注入',
        detail: '字符串拼接 dept 参数',
        suggestion: '改用参数化查询',
      },
    ],
  },
  logic: {
    findings: [
      {
        file: 'backend/src/chat/ChatService.java',
        line: 888, // 编造行号
        severity: 'blocker',
        title: '编造的问题',
        detail: '不存在的位置',
        suggestion: '无',
      },
    ],
  },
  performance: { findings: [] },
  arch: { findings: [] },
}

const THINK_MS = 300

/** 起一个假的 OpenAI 兼容端点，记录每个维度请求的到达时刻。 */
function startFakeModel() {
  const state = { seen: [], arrivals: [] }

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const payload = JSON.parse(body)
      const userContent = payload.messages[1].content

      let dimension = 'unknown'
      for (const name of Object.keys(RESPONSES)) {
        if (userContent.includes(`维度：${name}`)) {
          dimension = name
          break
        }
      }
      state.seen.push(dimension)
      state.arrivals.push({ dimension, at: Date.now() })

      // 模拟模型思考耗时，用于验证并发
      setTimeout(() => {
        const content = JSON.stringify(RESPONSES[dimension] || { findings: [] })
        const data = JSON.stringify({ choices: [{ message: { content } }] })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
        res.end(data)
      }, THINK_MS)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port })
    })
  })
}

/**
 * 异步运行评审器。
 *
 * 关键：必须用 spawn 而不是 spawnSync —— 假模型服务器与测试在同一个进程内，
 * spawnSync 会阻塞事件循环，服务器无法响应请求，测试直接死锁。
 */
function runReview(port, diffFile, outDir, extra = [], envOverride = {}) {
  const env = {
    ...process.env,
    AI_REVIEW_BASE_URL: `http://127.0.0.1:${port}/v1`,
    AI_REVIEW_API_KEY: 'test-key',
    AI_REVIEW_MODEL: 'fake-model',
    ...envOverride,
  }
  // 清掉可能从 .env 继承来的真实端点，避免打到真实模型
  delete env.LLM_BASE_URL
  delete env.LLM_API_KEY
  for (const key of Object.keys(envOverride)) {
    if (envOverride[key] === undefined) delete env[key]
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        REVIEW,
        '--diff-file', diffFile,
        '--base', 'base',
        '--head', 'head',
        '--report-dir', outDir,
        ...extra,
      ],
      { env },
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))

    setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`评审器超时未结束\nstdout=${stdout}\nstderr=${stderr}`))
    }, 120000).unref()
  })
}

test('端到端：假模型下四维度并发、编造降级、门禁阻断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'air-e2e-'))
  const diffFile = join(dir, 'pr.diff')
  writeFileSync(diffFile, DIFF, 'utf8')
  const outDir = join(dir, 'report')

  const { server, state, port } = await startFakeModel()
  try {
    const proc = await runReview(port, diffFile, outDir)
    assert.equal(proc.status, 1, `应被阻断，实际 ${proc.status}\n${proc.stdout}\n${proc.stderr}`)

    // 四个维度都收到了请求，且各维度互不覆盖
    assert.deepEqual(state.seen.slice().sort(), ['arch', 'logic', 'performance', 'security'])

    // 并发验证：四个请求的到达时刻必须挤在远小于单次思考耗时（300ms）的窗口内。
    // 用到达时间而不是总墙钟，避免进程启动/调度抖动把测试搞成偶发失败。
    const times = state.arrivals.map((a) => a.at)
    const span = Math.max(...times) - Math.min(...times)
    assert.ok(span < THINK_MS, `四个维度未并发发出：到达跨度 ${span}ms，应小于 ${THINK_MS}ms`)

    const report = JSON.parse(readFileSync(join(outDir, 'ai-review-report.json'), 'utf8'))
    const findings = report.findings

    // critical 被归一为 blocker 且验证通过，因此阻断
    const injected = findings.find((f) => f.file.endsWith('ChatService.java') && f.verified)
    assert.equal(injected.severity, 'blocker')
    assert.equal(injected.dimension, 'security')
    assert.equal(report.gate.verdict, 'BLOCKED')
    assert.equal(report.gate.blocked, true)

    // 编造行号的问题被保留但降级，且不在阻断清单里
    const fabricated = findings.filter((f) => f.line === 888)
    assert.ok(fabricated.length)
    assert.equal(fabricated[0].verified, false)
    assert.equal(fabricated[0].severity, 'low')
    assert.ok(!report.gate.blocking_ids.some((id) => id.includes('888')))
  } finally {
    server.close()
  }
})

test('无密钥时默认 fail-open，不阻断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'air-open-'))
  const diffFile = join(dir, 'pr.diff')
  writeFileSync(diffFile, DIFF, 'utf8')

  const proc = await runReview(0, diffFile, join(dir, 'report'), [], {
    AI_REVIEW_API_KEY: undefined,
    LLM_API_KEY: undefined,
    LLM_BASE_URL: undefined,
  })
  assert.equal(proc.status, 0, `未配置密钥时默认 fail-open，不应阻断\n${proc.stderr}`)
  assert.match(proc.stderr, /评审未执行/)
})

test('无密钥 + fail-closed 时返回 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'air-closed-'))
  const diffFile = join(dir, 'pr.diff')
  writeFileSync(diffFile, DIFF, 'utf8')

  const proc = await runReview(0, diffFile, join(dir, 'report'), ['--fail-closed'], {
    AI_REVIEW_API_KEY: undefined,
    LLM_API_KEY: undefined,
    LLM_BASE_URL: undefined,
  })
  assert.equal(proc.status, 2, '启用 fail-closed 时必须阻断')
})

test('配置错误一律返回 2，不与门禁命中混淆', async () => {
  const cases = [
    { args: ['--fail-on', 'nonsense'], label: 'fail-on 写错' },
    { args: ['--dimensions', 'nope'], label: '未知维度' },
    { args: ['--dimensions', ','], label: '空维度' },
    { args: ['--prompt-dir', '/nonexistent-xyz'], label: '缺提示词' },
  ]

  const dir = mkdtempSync(join(tmpdir(), 'air-cfg-'))
  const diffFile = join(dir, 'pr.diff')
  writeFileSync(diffFile, DIFF, 'utf8')

  for (const { args, label } of cases) {
    const proc = await runReview(0, diffFile, join(dir, 'report'), args)
    assert.equal(proc.status, 2, `${label} 应返回 2，实际 ${proc.status}`)
  }
})

test('没有改动时退出 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'air-empty-'))
  const diffFile = join(dir, 'empty.diff')
  writeFileSync(diffFile, '', 'utf8')

  const proc = await runReview(0, diffFile, join(dir, 'report'), ['--dry-run'])
  assert.equal(proc.status, 0)
  assert.match(proc.stdout, /没有可评审的改动/)
})
