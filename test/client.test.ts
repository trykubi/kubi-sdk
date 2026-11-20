import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kubi, KubiError, KubiTimeoutError, type Operation, OperationFailedError } from '../src/index.ts'
import { apiError, BASE, type Call, example, fakeApi, operationIds, schemaErrors, spec } from './fake-api.ts'

const SCR = 'scr_0123456789abcdefghij'
const SCR2 = 'scr_abcdefghij0123456789'
const OP = 'op_0123456789abcdefghij'
const EX = 'ex_0123456789abcdefghij'
const SHOT = 'shot_0123456789abcdefghij'
const TPL = 'tpl_0123456789abcdefghij'
const SNAP = 'snap_0123456789abcdefghij'
const evt = (n: number) => `evt_${String(n).padStart(20, '0')}`

let api = fakeApi()
function client(opts: ConstructorParameters<typeof Kubi>[0] = {}) {
  api = fakeApi()
  return new Kubi({ apiKey: 'test_key', run: 'run_test', fetch: api.fetch, ...opts })
}

afterEach(() => {
  // Every request any test made conforms to the spec, and every reply came from it.
  expect(api.problems).toEqual([])
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const operation = (status: string, extra: Partial<Operation> = {}): Operation => ({
  ...example('getOperation'),
  id: OP,
  status,
  done_at: null,
  ...extra,
})
const exec = (status: string) => ({ ...example('startExec', 202), id: EX, status })
const history = (...ids: number[]) => ({
  data: ids.map((n) => ({ ...example('listHistory').data[0], id: evt(n) })),
  next: null,
})

describe('the fake API itself', () => {
  it('finds every example in the spec valid against its schema', () => {
    const bad: string[] = []
    for (const item of Object.values(spec.paths) as Record<string, { operationId: string; responses: object }>[])
      for (const op of Object.values(item))
        for (const status of Object.keys(op.responses).filter((s) => s.startsWith('2'))) {
          const body = example(op.operationId, Number(status))
          if (body === undefined) continue
          const schema = (op.responses as Record<string, { content: Record<string, { schema: object }> }>)[status]
            .content['application/json'].schema
          for (const e of schemaErrors(schema, body)) bad.push(`${op.operationId} ${status}: ${e}`)
        }
    expect(bad).toEqual([])
  })

  it('refuses a request the spec does not allow', async () => {
    const kubi = client()
    // biome-ignore lint/suspicious/noExplicitAny: deliberately off-spec.
    await expect(kubi.screen(SCR).click({ x: 1, y: 2, bogus: true } as any)).rejects.toThrow(/fake api/)
    await expect(kubi.screen('nope').get()).rejects.toThrow(/fake api/)
    expect(api.problems).toHaveLength(2)
    api.problems.length = 0
  })
})

describe('shape', () => {
  it('reaches every operation in the public spec with valid requests', async () => {
    const kubi = client()
    const s = kubi.screen(SCR)
    await kubi.screens.list({ limit: 5, state: 'running' })
    await kubi.screens.create({ name: 'arthur-main' })
    await kubi.screens.get(SCR)
    await s.update({ name: 'billing-bot' })
    await s.delete()
    await s.start()
    await s.stop()
    await s.restart()
    await s.convert({ kind: 'persistent' })
    await kubi.templates.list()
    await kubi.templates.create({ screen_id: SCR, name: 'osworld-base' })
    await kubi.templates.get(TPL)
    expect(await kubi.templates.delete(TPL)).toBeUndefined()
    await s.snapshots.list()
    await s.snapshots.create({ name: 'before-upgrade' })
    await s.snapshots.delete(SNAP)
    await s.reset({ snapshot_id: SNAP })
    await kubi.operations.get(OP, { wait_s: 25 })
    await s.operations.list({ limit: 20 })
    await s.screenshot({ format: 'webp', quality: 70, cursor: false, settle: true })
    expect(await s.screenshotImage({ size: '1280x720' })).toBeInstanceOf(Uint8Array)
    await s.act([{ type: 'click', x: 450, y: 280 }], { screenshot_id: SHOT, screenshot: 'after' })
    await s.tree({ query: 'Save', max_elements: 50 })
    await s.act([{ type: 'invoke', element: 'e1' }], { screenshot_id: SHOT, tree: 'after' })
    await s.apps()
    await s.page({ op: 'read' })
    await s.script({ code: 'return 1' })
    await s.click({ x: 450, y: 280, screenshot: 'after' })
    await s.type({ text: 'quarterly report', enter: true })
    await s.press({ keys: 'ctrl+s' })
    await s.scroll({ x: 640, y: 400, dy: 5 })
    await s.drag({
      path: [
        [300, 400],
        [900, 400],
      ],
    })
    await s.move({ x: 640, y: 52 })
    await s.exec({ command: 'node --version' })
    await s.execs.get(EX, { until: 'exit', wait_s: 25, tail: true })
    await s.execs.kill(EX, { signal: 'TERM' })
    await s.files.upload('/home/user/data/input.csv', new TextEncoder().encode('a,b\n'), { mode: '0600' })
    expect(await s.files.download('/home/user/report.pdf')).toEqual(new Uint8Array([1, 2, 3]))
    await s.files.list('/home/user/Downloads')
    await s.clipboard.set({ text: 'Quarterly report, Q3 2026' })
    await s.clipboard.get()
    await s.type({ text: 'a long report', via: 'paste' })
    await s.viewerLink()
    await s.history.list({ limit: 20, errors_only: true })
    expect(await s.history.screenshot(SHOT)).toBeInstanceOf(Uint8Array)
    await kubi.me()
    await kubi.openApi()
    await kubi.secrets.list()
    expect([...new Set(api.ops())].sort()).toEqual([...operationIds].sort())
  })

  it('sends uploads as raw bytes', async () => {
    const kubi = client()
    await kubi.screen(SCR).files.upload('notes.txt', 'hello')
    const call = api.calls[0]
    expect(call.headers.get('content-type')).toBe('application/octet-stream')
    expect(new TextDecoder().decode(call.body as Uint8Array)).toBe('hello')
    expect(call.query.get('path')).toBe('notes.txt')
  })
})

describe('transport', () => {
  it('sends the key, the run and the base path, and a key only on changing calls', async () => {
    const kubi = client()
    await kubi.screens.list()
    await kubi.screen(SCR).start()
    const [list, start] = api.calls
    expect(list.headers.get('authorization')).toBe('Bearer test_key')
    expect(list.headers.get('kubi-run')).toBe('run_test')
    expect(list.headers.get('user-agent')).toMatch(/^kubi-sdk-ts\//)
    expect(list.headers.has('idempotency-key')).toBe(false)
    expect(start.headers.get('idempotency-key')).toMatch(/^idem_[0-9a-z]{20}$/)
    expect(BASE).toBe('https://api.trykubi.com/v1')
  })

  it('takes the key from code, then KUBI_API_KEY', async () => {
    vi.stubEnv('KUBI_API_KEY', 'env_key')
    await client({ apiKey: 'code_key' }).me()
    expect(api.calls[0].headers.get('authorization')).toBe('Bearer code_key')
    await client({ apiKey: undefined }).me()
    expect(api.calls[0].headers.get('authorization')).toBe('Bearer env_key')
    vi.stubEnv('KUBI_API_KEY', '')
    expect(() => new Kubi()).toThrow(/KUBI_API_KEY/)
  })

  it('takes the run from code, then KUBI_RUN, then CLAUDE_CODE_SESSION_ID, then one id per client', () => {
    vi.stubEnv('KUBI_RUN', 'env_run')
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'session_1')
    expect(client({ run: 'code_run' }).run).toBe('code_run')
    expect(client({ run: undefined }).run).toBe('env_run')
    vi.stubEnv('KUBI_RUN', '')
    expect(client({ run: undefined }).run).toBe('session_1')
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '')
    const a = client({ run: undefined })
    expect(a.run).toMatch(/^run_[0-9a-z]{20}$/)
    expect(client({ run: undefined }).run).not.toBe(a.run)
  })

  it('resends a retryable failure with the same idempotency key', async () => {
    const kubi = client()
    api.on('startExec', apiError(503, 'SCREEN_UNAVAILABLE', { retryable: true, retry_after: 0 }))
    const run = await kubi.screen(SCR).exec({ command: 'echo hi' })
    expect(run.status).toBe('exited')
    expect(api.calls).toHaveLength(2)
    const key = api.calls[0].headers.get('idempotency-key')
    expect(key).toMatch(/^idem_/)
    expect(api.calls[1].headers.get('idempotency-key')).toBe(key)
  })

  it('gives up after maxRetries', async () => {
    const kubi = client({ maxRetries: 1 })
    const internal = apiError(500, 'INTERNAL', { retryable: true, retry_after: 0 })
    api.on('click', internal, internal, internal)
    await expect(kubi.screen(SCR).click({ x: 1, y: 1 })).rejects.toMatchObject({ status: 500, code: 'INTERNAL' })
    expect(api.calls).toHaveLength(2)
  })

  it('never retries a 504 or a failure not marked retryable', async () => {
    const kubi = client()
    api.on('runActions', apiError(504, 'OUTCOME_UNKNOWN', { retryable: true, outcome: 'unknown' }))
    await expect(kubi.screen(SCR).act([{ type: 'key', keys: 'Return' }])).rejects.toMatchObject({
      status: 504,
      outcome: 'unknown',
    })
    expect(api.calls).toHaveLength(1)
    api.on('runActions', apiError(409, 'CONTROL_HELD', { retry_after: 120 }))
    await expect(kubi.screen(SCR).act([{ type: 'key', keys: 'Return' }])).rejects.toMatchObject({
      code: 'CONTROL_HELD',
      retryAfter: 120,
    })
    expect(api.calls).toHaveLength(2)
  })

  it('honours Retry-After before resending', async () => {
    vi.useFakeTimers()
    const kubi = client()
    api.on('click', apiError(429, 'RATE_LIMITED', { retryable: true, retry_after: 1, headers: { 'Retry-After': '3' } }))
    const done = kubi.screen(SCR).click({ x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(2999)
    expect(api.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(api.calls).toHaveLength(2)
  })

  it('hands back a Retry-After longer than 30 s instead of sleeping on it', async () => {
    const kubi = client()
    api.on(
      'getMe',
      apiError(429, 'RATE_LIMITED', { retryable: true, retry_after: 90, headers: { 'Retry-After': '90' } }),
    )
    await expect(kubi.me()).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfter: 90 })
    expect(api.calls).toHaveLength(1)
  })

  it('turns an error reply into a KubiError', async () => {
    const kubi = client()
    api.on('getScreen', apiError(404, 'SCREEN_NOT_FOUND'))
    const e = await kubi.screens.get(SCR).catch((e) => e)
    expect(e).toBeInstanceOf(KubiError)
    expect(e).toMatchObject({
      name: 'KubiError',
      status: 404,
      code: 'SCREEN_NOT_FOUND',
      retryable: false,
      outcome: 'not_applied',
      requestId: 'req_0123456789abcdefghij',
      message: 'SCREEN_NOT_FOUND. Do the fix.',
    })
  })

  it('warns once per deprecated route', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kubi = client()
    const deprecated = { headers: { Deprecation: '@1798761600', Sunset: 'Fri, 01 Jan 2027 00:00:00 GMT' } }
    api.on('getScreen', deprecated, deprecated)
    api.on('getMe', deprecated)
    await kubi.screens.get(SCR)
    await kubi.screens.get(SCR2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/GET \/screens\/\{screen_id\} is deprecated, gone after Fri/)
    await kubi.me()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('lists', () => {
  it('follows next through every page', async () => {
    const kubi = client()
    const screen = example('listScreens').data[0]
    const page = (ids: string[], next: string | null) => ({
      body: { data: ids.map((id) => ({ ...screen, id })), next },
    })
    api.on('listScreens', page([SCR], 'c1'), page([SCR2], 'c2'), page([], null))
    const ids: string[] = []
    for await (const s of kubi.screens.all({ limit: 1 })) ids.push(s.id)
    expect(ids).toEqual([SCR, SCR2])
    expect(api.calls.map((c) => c.query.get('after'))).toEqual([null, 'c1', 'c2'])
    expect(api.calls.every((c) => c.query.get('limit') === '1')).toBe(true)
  })
})

describe('waiting', () => {
  const pollSeconds = (c: Call) => Number(c.query.get('wait_s'))

  it('waits for an operation to succeed with long polls', async () => {
    const kubi = client()
    api.on(
      'getOperation',
      { body: operation('queued') },
      { body: operation('reconciling') },
      {
        body: operation('succeeded'),
      },
    )
    const op = await kubi.operations.wait(OP)
    expect(op.status).toBe('succeeded')
    expect(api.calls.map(pollSeconds)).toEqual([25, 25, 25])
  })

  it('throws OperationFailedError with the operation error', async () => {
    const kubi = client()
    const { error } = apiError(503, 'NO_CAPACITY').body as { error: Operation['error'] }
    api.on('getOperation', { body: operation('running') }, { body: operation('failed', { error }) })
    const e = await kubi.waitForOperation(OP).catch((e) => e)
    expect(e).toBeInstanceOf(OperationFailedError)
    expect(e).toBeInstanceOf(KubiError)
    expect(e.code).toBe('NO_CAPACITY')
    expect(e.operation.id).toBe(OP)
  })

  it('times out with the last operation, never polling past the deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const kubi = client()
    const held = (c: Call) => {
      vi.setSystemTime(Date.now() + pollSeconds(c) * 1000) // the API holds the poll this long
      return { body: operation('running') }
    }
    api.on('getOperation', held, held, held, held)
    const e = await kubi.operations.wait(OP, { timeoutMs: 60_000 }).catch((e) => e)
    expect(e).toBeInstanceOf(KubiTimeoutError)
    expect(e.last.status).toBe('running')
    expect(api.calls.map(pollSeconds)).toEqual([25, 25, 10])
  })

  it('waits for an exec to end', async () => {
    const kubi = client()
    api.on('startExec', { status: 202, body: exec('running') })
    api.on('getExec', { body: exec('running') }, { body: exec('exited') })
    const s = kubi.screen(SCR)
    const started = await s.exec({ command: 'npm ci', wait_s: 5 })
    expect(started.status).toBe('running')
    const done = await s.waitForExec(started.id, { tail: true })
    expect(done.status).toBe('exited')
    const polls = api.calls.filter((c) => c.op === 'getExec')
    expect(polls.map((c) => [c.path.exec_id, c.query.get('until'), pollSeconds(c), c.query.get('tail')])).toEqual([
      [EX, 'exit', 25, 'true'],
      [EX, 'exit', 25, 'true'],
    ])
  })

  it('splits a long wait into waits the API accepts', async () => {
    const kubi = client()
    await kubi.screen(SCR).wait(45_000, { screenshot: 'after' })
    expect(api.calls.map((c) => c.body)).toEqual([
      { actions: [{ type: 'wait', ms: 20_000 }] },
      { actions: [{ type: 'wait', ms: 20_000 }] },
      { screenshot: 'after', actions: [{ type: 'wait', ms: 5_000 }] },
    ])
  })

  it('settles', async () => {
    const kubi = client()
    await kubi.screen(SCR).settle({ quiet_ms: 500, screenshot: 'after' })
    expect(api.calls[0].body).toEqual({ screenshot: 'after', actions: [{ type: 'settle', quiet_ms: 500 }] })
  })

  it('zooms into a region of a named screenshot', async () => {
    const kubi = client()
    await kubi.screen(SCR).zoom(SHOT, [10, 20, 330, 200], { max_upscale: '2' })
    const q = api.calls[0].query
    expect([q.get('region'), q.get('screenshot_id'), q.get('max_upscale')]).toEqual(['10,20,330,200', SHOT, '2'])
  })

  it('follows history from now, oldest first, until the loop breaks', async () => {
    const kubi = client()
    api.on('listHistory', { body: history(1) }, { body: history(2, 3) }, { body: history() }, { body: history(4) })
    const seen: string[] = []
    for await (const row of kubi.screen(SCR).followHistory({ run: 'run_a' })) {
      seen.push(row.id)
      if (seen.length === 3) break
    }
    expect(seen).toEqual([evt(2), evt(3), evt(4)])
    const q = api.calls.map((c) => [c.query.get('since'), c.query.get('wait_s'), c.query.get('limit')])
    expect(q).toEqual([
      [null, null, '1'],
      [evt(1), '25', null],
      [evt(3), '25', null],
      [evt(3), '25', null],
    ])
    expect(api.calls.every((c) => c.query.get('run') === 'run_a')).toBe(true)
  })

  it('stops following history when the signal aborts', async () => {
    const kubi = client()
    const stop = new AbortController()
    api.on('listHistory', () => {
      stop.abort()
      return { body: history() }
    })
    const rows = []
    for await (const row of kubi.screen(SCR).followHistory({ since: evt(9), signal: stop.signal })) rows.push(row)
    expect(rows).toEqual([])
    expect(api.calls).toHaveLength(1)
  })
})
