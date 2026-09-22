import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseKeyName } from './rules/key-relation.js'
import { decideProduction } from './rules/production-decision.js'
import { MIN_WINNER_PROBABILITY, MIN_WINNER_MARGIN_PP } from './rules/qc-status.js'

// ===== CONFIG =====
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const ENGINE_DIR = path.join(PROJECT_ROOT, 'engine')
const ENGINE_PACKAGE = path.join(ENGINE_DIR, 'skey')
const ADAPTER_SCRIPT = path.join(PROJECT_ROOT, 'skey-adapter', 'analyze.py')
const TEMP_DIR = path.join(os.tmpdir(), 'key-qc')

const PORT = Number(process.env.PORT ?? 8080)
const API_KEY = process.env.KEY_QC_API_KEY ?? ''
const MAX_CONCURRENT = Math.max(1, Number(process.env.KEY_QC_MAX_CONCURRENT ?? 2))
const MAX_AUDIO_BYTES = Number(process.env.KEY_QC_MAX_AUDIO_BYTES ?? 1024 * 1024 * 1024)
const ANALYZE_TIMEOUT_MS = Number(process.env.KEY_QC_TIMEOUT_MS ?? 10 * 60 * 1000)
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_PRODUCER_KEY_LENGTH = 32

const EXPECTED_ENGINE = 'skey'
const EXPECTED_SCORE_TYPE = 'probability'
const EXPECTED_CANDIDATE_COUNT = 24

if (process.env.NODE_ENV === 'production' && API_KEY === '') {
  console.error('[key-qc] KEY_QC_API_KEY is required in production')
  process.exit(1)
}

// ===== ENGINE RUNTIME =====
function enginePythonCandidates() {
  const binary = process.platform === 'win32'
    ? path.join('Scripts', 'python.exe')
    : path.join('bin', 'python')

  return [
    ...(process.env.SKEY_PYTHON ? [process.env.SKEY_PYTHON] : []),
    path.join(ENGINE_DIR, '.venv', binary),
    path.join(PROJECT_ROOT, '.venv', binary),
  ]
}

function resolveEnginePython() {
  return enginePythonCandidates().find(candidate => fs.existsSync(candidate)) ?? null
}

// ===== CONCURRENCY =====
let running = 0
const waiting = []

async function withSlot(task) {
  if (running >= MAX_CONCURRENT) {
    await new Promise(resolve => waiting.push(resolve))
  }
  running += 1
  try {
    return await task()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

// ===== HTTP HELPERS =====
function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

function authorized(req) {
  if (API_KEY === '') return true
  const given = Buffer.from(String(req.headers['x-api-key'] ?? ''))
  const expected = Buffer.from(API_KEY)
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isProbability(value) {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

function decodeHeaderValue(value) {
  if (typeof value !== 'string') return ''
  try {
    return decodeURIComponent(value).trim()
  } catch {
    return value.trim()
  }
}

// ===== UPLOAD =====
function decodeClientFileName(clientFileName) {
  try {
    return path.basename(decodeURIComponent(clientFileName ?? ''))
  } catch {
    return ''
  }
}

function tempPathFor(clientFileName) {
  const rawExtension = path.extname(decodeClientFileName(clientFileName)).toLowerCase()
  const extension = /^\.[a-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : '.wav'
  return path.join(TEMP_DIR, `sample-${crypto.randomUUID()}${extension}`)
}

function streamRequestToFile(req, targetPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(TEMP_DIR, { recursive: true })

    const out = fs.createWriteStream(targetPath)
    let received = 0
    let settled = false

    const fail = error => {
      if (settled) return
      settled = true
      out.destroy()
      reject(error)
    }

    req.on('data', chunk => {
      received += chunk.length
      if (received > MAX_AUDIO_BYTES) {
        fail(new Error('Audio file is too large to analyze'))
        req.destroy()
      }
    })

    req.on('error', fail)
    out.on('error', fail)

    out.on('finish', () => {
      if (settled) return
      settled = true
      if (received === 0) {
        reject(new Error('No audio data was received'))
        return
      }
      resolve(received)
    })

    req.pipe(out)
  })
}

// ===== ADAPTER =====
function runAdapter(audioPath) {
  return new Promise((resolve, reject) => {
    const enginePython = resolveEnginePython()

    if (enginePython === null) {
      reject(new Error('S-KEY runtime not found. Set SKEY_PYTHON to a Python that has engine/requirements.txt installed.'))
      return
    }
    if (!fs.existsSync(ENGINE_PACKAGE)) {
      reject(new Error('Vendored S-KEY engine not found (engine/skey)'))
      return
    }
    if (!fs.existsSync(ADAPTER_SCRIPT)) {
      reject(new Error('S-KEY adapter script not found (skey-adapter/analyze.py)'))
      return
    }

    let child
    try {
      child = spawn(
        enginePython,
        [ADAPTER_SCRIPT, audioPath, '--device', 'cpu', '--skey-root', ENGINE_DIR],
        { shell: false, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }
      )
    } catch (error) {
      reject(new Error(`Could not start the S-KEY process: ${error.message}`))
      return
    }

    const stdoutChunks = []
    const stderrChunks = []
    let stdoutBytes = 0
    let settled = false
    let timedOut = false

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      finish(new Error('Analysis timed out'))
    }, ANALYZE_TIMEOUT_MS)

    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill()
        finish(new Error('S-KEY produced an unexpectedly large response'))
        return
      }
      stdoutChunks.push(chunk)
    })

    child.stderr.on('data', chunk => stderrChunks.push(chunk))

    child.on('error', error => {
      finish(new Error(`Could not start the S-KEY process: ${error.message}`))
    })

    child.on('close', code => {
      if (timedOut) return
      finish(null, {
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      })
    })
  })
}

function sanitizeAdapterMessage(message, audioPath, displayName) {
  const shown = displayName === '' ? 'the audio file' : displayName
  return String(message ?? '')
    .replaceAll(audioPath.replace(/\\/g, '\\\\'), shown)
    .replaceAll(audioPath, shown)
    .trim()
}

// ===== ENGINE CONTRACT =====
function analysisError(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'S-KEY returned a malformed response'
  }
  if (payload.ok === false) {
    return typeof payload.error === 'string' && payload.error !== ''
      ? `S-KEY could not analyze this file: ${payload.error}`
      : 'S-KEY could not analyze this file'
  }
  if (payload.engine !== EXPECTED_ENGINE) {
    return `Unexpected engine "${payload.engine}"`
  }
  if (payload.scoreType !== EXPECTED_SCORE_TYPE) {
    return `Unexpected scoreType "${payload.scoreType}" (expected "${EXPECTED_SCORE_TYPE}")`
  }

  const candidates = payload.candidates
  if (!Array.isArray(candidates)) {
    return 'S-KEY response has no candidate list'
  }
  if (candidates.length !== EXPECTED_CANDIDATE_COUNT) {
    return `Expected ${EXPECTED_CANDIDATE_COUNT} candidates, got ${candidates.length}`
  }

  let total = 0
  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index]
    const position = index + 1

    if (!entry || typeof entry !== 'object') return `Candidate #${position} is malformed`
    if (entry.rank !== position) return `Candidate #${position} has rank ${entry.rank}`
    if (typeof entry.key !== 'string' || entry.key === '') return `Candidate #${position} has no key name`
    if (!isProbability(entry.probability)) return `Candidate #${position} has an invalid probability`
    if (!isFiniteNumber(entry.logit)) return `Candidate #${position} has an invalid logit`
    if (!Number.isInteger(entry.classIndex) || entry.classIndex < 0 || entry.classIndex >= EXPECTED_CANDIDATE_COUNT) {
      return `Candidate #${position} has an invalid classIndex`
    }
    if (index > 0 && entry.probability > candidates[index - 1].probability) {
      return 'Candidates are not ranked by descending probability'
    }
    total += entry.probability
  }

  if (new Set(candidates.map(entry => entry.key)).size !== EXPECTED_CANDIDATE_COUNT) {
    return 'Candidate list contains duplicate keys'
  }
  if (new Set(candidates.map(entry => entry.classIndex)).size !== EXPECTED_CANDIDATE_COUNT) {
    return 'Candidate list contains duplicate class indices'
  }
  if (Math.abs(total - 1) > 1e-3) {
    return `Candidate probabilities sum to ${total}, not 1`
  }
  if (typeof payload.winner !== 'string' || payload.winner === '') {
    return 'S-KEY response has no winner'
  }
  if (payload.winner !== candidates[0].key) {
    return `Winner "${payload.winner}" does not match top candidate "${candidates[0].key}"`
  }
  if (!isProbability(payload.winnerScore)) {
    return 'S-KEY response has an invalid winner score'
  }
  if (payload.winnerScore !== candidates[0].probability) {
    return 'Winner score does not match the top candidate probability'
  }
  return null
}

// ===== ANALYSIS =====
async function analyzeUploadedAudio(req) {
  const audioPath = tempPathFor(req.headers['x-file-name'])
  const displayName = decodeClientFileName(req.headers['x-file-name'])
  const cleanup = () => fs.rmSync(audioPath, { force: true })

  try {
    try {
      await streamRequestToFile(req, audioPath)
    } catch (error) {
      return { ok: false, status: 400, error: error.message }
    }

    let outcome
    try {
      outcome = await withSlot(() => runAdapter(audioPath))
    } catch (error) {
      console.error('[key-qc] adapter could not run:', error)
      return { ok: false, status: 500, error: error.message }
    }

    if (outcome.stderr.trim() !== '') {
      console.log(`[key-qc] adapter stderr:\n${outcome.stderr.trim()}`)
    }

    let payload
    try {
      payload = JSON.parse(outcome.stdout)
    } catch {
      console.error(
        `[key-qc] adapter exited ${outcome.code} with unparseable stdout:\n`
        + `${outcome.stdout.slice(0, 2000)}\n--- stderr ---\n${outcome.stderr.slice(-2000)}`
      )
      return {
        ok: false,
        status: 502,
        error: outcome.code === 0
          ? 'S-KEY did not return valid JSON'
          : `S-KEY exited with code ${outcome.code} and returned no result`,
      }
    }

    const problem = analysisError(payload)
    if (problem) {
      console.error(`[key-qc] rejected adapter response: ${problem}`)
      return { ok: false, status: 502, error: sanitizeAdapterMessage(problem, audioPath, displayName) }
    }

    return { ok: true, payload }
  } catch (error) {
    console.error('[key-qc] unexpected failure:', error)
    return { ok: false, status: 500, error: 'Analysis failed unexpectedly' }
  } finally {
    try {
      cleanup()
    } catch (error) {
      console.error('[key-qc] could not delete temp file:', error.message)
    }
  }
}

// ===== ROUTES =====
function producerKeyFrom(req, url) {
  const fromHeader = decodeHeaderValue(req.headers['x-producer-key'])
  return fromHeader !== '' ? fromHeader : decodeHeaderValue(url.searchParams.get('producerKey') ?? '')
}

async function handleKeyQc(req, res, url) {
  const producerKey = producerKeyFrom(req, url)

  if (producerKey === '') {
    sendJson(res, 400, { error: 'Missing Producer Key. Send it as the X-Producer-Key header or a ?producerKey= query parameter.' })
    return
  }
  if (producerKey.length > MAX_PRODUCER_KEY_LENGTH) {
    sendJson(res, 400, { error: 'Producer Key is too long' })
    return
  }
  if (parseKeyName(producerKey) === null) {
    sendJson(res, 400, {
      error: `Unrecognized Producer Key "${producerKey}". Expected a major or minor key, for example "D# minor" or "C Major".`,
    })
    return
  }

  const outcome = await analyzeUploadedAudio(req)
  if (!outcome.ok) {
    sendJson(res, outcome.status, { error: outcome.error })
    return
  }

  let decision
  try {
    decision = decideProduction({ producerKey, analysis: outcome.payload })
  } catch (error) {
    console.error('[key-qc] could not decide:', error)
    sendJson(res, 502, { error: 'S-KEY returned no usable candidates' })
    return
  }

  sendJson(res, 200, {
    engine: outcome.payload.engine,
    pipelineVersion: outcome.payload.pipelineVersion,
    file: { name: decodeClientFileName(req.headers['x-file-name']) },
    producerKey: decision.producerKey,
    detectedKey: decision.detectedKey,
    relation: decision.relation,
    verdict: decision.verdict,
    qcStatus: decision.status,
    action: decision.action,
    reason: decision.reason,
    winnerProbability: decision.winnerProbability,
    winnerMarginPp: decision.winnerMarginPp,
    thresholds: {
      minWinnerProbability: MIN_WINNER_PROBABILITY,
      minWinnerMarginPp: MIN_WINNER_MARGIN_PP,
    },
    candidates: decision.candidates,
  })
}

function handleHealth(res) {
  const ready = resolveEnginePython() !== null && fs.existsSync(ENGINE_PACKAGE) && fs.existsSync(ADAPTER_SCRIPT)
  sendJson(res, ready ? 200 : 503, { ok: ready, engine: EXPECTED_ENGINE, running, waiting: waiting.length })
}

// ===== SERVER =====
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      handleHealth(res)
      return
    }
    if (url.pathname === '/api/key-qc' && req.method === 'POST') {
      if (!authorized(req)) {
        sendJson(res, 401, { error: 'Invalid API key' })
        req.resume()
        return
      }
      await handleKeyQc(req, res, url)
      return
    }
    sendJson(res, 404, { error: 'Not found' })
  } catch (error) {
    console.error('[key-qc] request failed:', error)
    if (!res.headersSent) sendJson(res, 500, { error: 'Request failed' })
  }
})

server.requestTimeout = 0
server.listen(PORT, () => {
  console.log(`[key-qc] listening on :${PORT} (max ${MAX_CONCURRENT} concurrent, auth ${API_KEY ? 'on' : 'off'})`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
