// The Kubi TypeScript SDK. Types come from the public spec (src/types.gen.ts, by scripts/gen.sh); the client is
// written by hand so that a click is never retried as new work. Method names follow the TypeScript samples in the
// spec (x-codeSamples), so the docs, the spec and the SDK say the same thing.
import createClient, { type Middleware } from 'openapi-fetch'
import type { components, operations, paths } from './types.gen.js'

export type { components, operations, paths }

type Schemas = components['schemas']
export type Screen = Schemas['Screen']
export type Operation = Schemas['Operation']
export type Exec = Schemas['Exec']
export type Screenshot = Schemas['Screenshot']
export type Action = Schemas['Action']
export type ActionsResponse = Schemas['ActionsResponse']
export type HistoryEntry = Schemas['HistoryEntry']
export type ApiError = Schemas['Error']
/** The query parameters of one operation in the spec. */
export type Query<K extends keyof operations> = NonNullable<operations[K]['parameters']['query']>

export const VERSION = '1.0.0'
const DEFAULT_BASE_URL = 'https://api.trykubi.com/v1'
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** A retry the API asks to come back later than this is handed to the caller instead of waited for. */
const MAX_RETRY_DELAY_MS = 30_000
/** The longest long poll the API holds (`wait_s`). */
const MAX_WAIT_S = 25
/** The longest single `wait` action the API runs. */
const MAX_WAIT_ACTION_MS = 20_000
const DEFAULT_TIMEOUT_MS = 600_000

export interface KubiOptions {
  /** An API key. Falls back to KUBI_API_KEY. */
  apiKey?: string
  baseUrl?: string
  /** Labels every call with Kubi-Run. Falls back to KUBI_RUN, then CLAUDE_CODE_SESSION_ID, then one id per client. */
  run?: string
  /** Retries of calls the API marks retryable. Default 2. */
  maxRetries?: number
  fetch?: typeof fetch
}

export interface WaitOptions {
  /** Give up after this long with a KubiTimeoutError. Default 10 minutes. */
  timeoutMs?: number
  signal?: AbortSignal
}

/** A failed call: `status` is the HTTP status, `code`, `retryable` and `outcome` come from the API's error body. */
export class KubiError extends Error {
  readonly status: number
  readonly body: ApiError | undefined
  constructor(status: number, body: ApiError | undefined, message?: string) {
    super(message ?? body?.error.message ?? `HTTP ${status}`)
    this.name = 'KubiError'
    this.status = status
    this.body = body
  }
  get code() {
    return this.body?.error.code
  }
  get retryable() {
    return this.body?.error.retryable ?? false
  }
  /** `unknown` means the call may have acted: look before acting again. */
  get outcome() {
    return this.body?.error.outcome
  }
  get retryAfter() {
    return this.body?.error.retry_after ?? undefined
  }
  get requestId() {
    return this.body?.error.request_id
  }
}

/** An operation that ended `failed`. Its error body is the operation's `error`. */
export class OperationFailedError extends KubiError {
  readonly operation: Operation
  constructor(operation: Operation) {
    const body = operation.error ? { error: operation.error } : undefined
    super(200, body, body?.error.message ?? `Kubi: operation ${operation.id} failed`)
    this.name = 'OperationFailedError'
    this.operation = operation
  }
}

/** A wait helper ran out of time. The work goes on: `last` is what the API said last. */
export class KubiTimeoutError<T = unknown> extends Error {
  readonly last: T
  constructor(message: string, last: T) {
    super(message)
    this.name = 'KubiTimeoutError'
    this.last = last
  }
}

function env(name: string): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env[name] || undefined
}

function randomId(prefix: string): string {
  const a = '0123456789abcdefghijklmnopqrstuvwxyz'
  return `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => a[b % 36]).join('')}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function isApiError(x: unknown): x is ApiError {
  return typeof x === 'object' && x !== null && typeof (x as ApiError).error === 'object'
}

async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p
  if (!response.ok) throw new KubiError(response.status, isApiError(error) ? error : undefined)
  return data as T
}

async function bytes(p: Promise<{ data?: ArrayBuffer; error?: unknown; response: Response }>): Promise<Uint8Array> {
  return new Uint8Array(await unwrap(p))
}

/** Retry-After (seconds or a date), else the body's retry_after, else a short backoff. */
function retryDelayMs(res: Response, body: ApiError, attempt: number): number {
  const header = res.headers.get('Retry-After')
  if (header !== null && header.trim() !== '') {
    const s = Number(header)
    if (Number.isFinite(s)) return Math.max(0, s * 1000)
    const at = Date.parse(header)
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  }
  const after = body.error.retry_after
  return typeof after === 'number' ? after * 1000 : 250 * 2 ** attempt
}

/** Seconds of long poll that fit in what is left of a deadline. */
const pollSeconds = (remainingMs: number) => Math.max(0, Math.min(MAX_WAIT_S, Math.ceil(remainingMs / 1000)))

/** Every item of a list, following `next` page by page. */
export async function* paginate<T>(
  page: (after: string | undefined) => Promise<{ data: T[]; next?: string | null }>,
): AsyncGenerator<T> {
  let after: string | undefined
  do {
    const p = await page(after)
    yield* p.data
    after = p.next ?? undefined
  } while (after)
}

type Raw = ReturnType<typeof createClient<paths>>

export class Kubi {
  /** The typed low-level client: every public path, as in the spec. */
  readonly raw: Raw
  readonly run: string
  private warned = new Set<string>()

  constructor(opts: KubiOptions = {}) {
    const apiKey = opts.apiKey ?? env('KUBI_API_KEY')
    if (!apiKey) throw new Error('Kubi: pass apiKey or set KUBI_API_KEY')
    this.run = opts.run ?? env('KUBI_RUN') ?? env('CLAUDE_CODE_SESSION_ID') ?? randomId('run')
    const maxRetries = opts.maxRetries ?? 2
    const baseFetch = opts.fetch ?? globalThis.fetch
    // Retries live under openapi-fetch, so a resend carries the same Idempotency-Key and can't act twice.
    const retryingFetch = async (input: Request): Promise<Response> => {
      for (let attempt = 0; ; attempt++) {
        const res = await baseFetch(input.clone())
        if (res.ok || attempt >= maxRetries || res.status === 504) return res
        const body = await res
          .clone()
          .json()
          .catch(() => undefined)
        if (!isApiError(body) || !body.error.retryable) return res
        const delay = retryDelayMs(res, body, attempt)
        if (delay > MAX_RETRY_DELAY_MS) return res
        await sleep(delay)
      }
    }
    this.raw = createClient<paths>({ baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL, fetch: retryingFetch })
    const headers: Middleware = {
      onRequest: ({ request }) => {
        request.headers.set('Authorization', `Bearer ${apiKey}`)
        request.headers.set('Kubi-Run', this.run)
        request.headers.set('User-Agent', `kubi-sdk-ts/${VERSION}`)
        if (MUTATING.has(request.method) && !request.headers.has('Idempotency-Key'))
          request.headers.set('Idempotency-Key', randomId('idem'))
        return request
      },
      onResponse: ({ request, response, schemaPath }) => {
        const route = `${request.method} ${schemaPath}`
        if (response.headers.has('Deprecation') && !this.warned.has(route)) {
          this.warned.add(route)
          const sunset = response.headers.get('Sunset')
          console.warn(
            `Kubi: ${route} is deprecated${sunset ? `, gone after ${sunset}` : ''} (${response.headers.get('Link') ?? 'see the changelog'})`,
          )
        }
        return response
      },
    }
    this.raw.use(headers)
  }

  readonly screens = {
    /** One page of screens, newest first. */
    list: (query: Query<'listScreens'> = {}) => unwrap(this.raw.GET('/screens', { params: { query } })),
    /** Every screen, page by page. */
    all: (query: Omit<Query<'listScreens'>, 'after'> = {}) =>
      paginate((after) => this.screens.list({ ...query, after })),
    /** Creates a screen; the reply is an operation to wait for. */
    create: (body: Schemas['ScreenCreate'] = {}) => unwrap(this.raw.POST('/screens', { body })),
    get: (id: string) => this.screen(id).get(),
  }

  readonly templates = {
    list: (query: Query<'listTemplates'> = {}) => unwrap(this.raw.GET('/templates', { params: { query } })),
    all: (query: Omit<Query<'listTemplates'>, 'after'> = {}) =>
      paginate((after) => this.templates.list({ ...query, after })),
    get: (id: string) => unwrap(this.raw.GET('/templates/{template_id}', { params: { path: { template_id: id } } })),
    /** Saves a screen as a template; the reply is an operation to wait for. */
    create: (body: Schemas['TemplateCreate']) => unwrap(this.raw.POST('/templates', { body })),
    delete: async (id: string): Promise<void> => {
      await unwrap(this.raw.DELETE('/templates/{template_id}', { params: { path: { template_id: id } } }))
    },
  }

  readonly operations = {
    /** With `wait_s` (0 to 25) the reply waits for the operation to change. */
    get: (id: string, query: Query<'getOperation'> = {}, signal?: AbortSignal) =>
      unwrap(this.raw.GET('/operations/{operation_id}', { params: { path: { operation_id: id }, query }, signal })),
    /** Long-polls until the operation succeeds; throws OperationFailedError if it fails. */
    wait: async (id: string, { timeoutMs = DEFAULT_TIMEOUT_MS, signal }: WaitOptions = {}): Promise<Operation> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const op = await this.operations.get(id, { wait_s: pollSeconds(deadline - Date.now()) }, signal)
        if (op.status === 'succeeded') return op
        if (op.status === 'failed') throw new OperationFailedError(op)
        // queued, running, reconciling (never retry, wait) and states this SDK doesn't know yet.
        if (Date.now() >= deadline)
          throw new KubiTimeoutError(`Kubi: operation ${id} is still ${op.status} after ${timeoutMs} ms`, op)
      }
    },
  }

  readonly secrets = {
    /** Names and scopes, never values. */
    list: () => unwrap(this.raw.GET('/secrets')),
  }

  /** The organization, this credential's permissions and screens, limits. Call it first. */
  me() {
    return unwrap(this.raw.GET('/me'))
  }

  /** The public spec as served. */
  openApi() {
    return unwrap(this.raw.GET('/openapi.json'))
  }

  /** Same as `operations.wait`. */
  waitForOperation(id: string, opts?: WaitOptions) {
    return this.operations.wait(id, opts)
  }

  /** One screen's calls. Makes no request by itself. */
  screen(id: string) {
    return new ScreenClient(this.raw, id)
  }
}

type ActOptions = Omit<Schemas['ActionsRequest'], 'actions'>
type Upload = Uint8Array | ArrayBuffer | Blob | string

/** One screen: power, screenshots, actions, commands, files, the viewer link and history. */
export class ScreenClient {
  readonly id: string
  private readonly raw: Raw
  private readonly path: { screen_id: string }

  constructor(raw: Raw, id: string) {
    this.raw = raw
    this.id = id
    this.path = { screen_id: id }
  }

  get() {
    return unwrap(this.raw.GET('/screens/{screen_id}', { params: { path: this.path } }))
  }
  /** Rename, recolour, label or set the end time. */
  update(body: Schemas['ScreenUpdate']) {
    return unwrap(this.raw.PATCH('/screens/{screen_id}', { params: { path: this.path }, body }))
  }
  delete() {
    return unwrap(this.raw.DELETE('/screens/{screen_id}', { params: { path: this.path } }))
  }
  start() {
    return unwrap(this.raw.POST('/screens/{screen_id}/start', { params: { path: this.path } }))
  }
  stop() {
    return unwrap(this.raw.POST('/screens/{screen_id}/stop', { params: { path: this.path } }))
  }
  restart() {
    return unwrap(this.raw.POST('/screens/{screen_id}/restart', { params: { path: this.path } }))
  }
  /** Switch between persistent and disposable. */
  convert(body: Schemas['ScreenConvert']) {
    return unwrap(this.raw.POST('/screens/{screen_id}/convert', { params: { path: this.path }, body }))
  }
  /** Go back to a snapshot. */
  reset(body: Schemas['ResetRequest']) {
    return unwrap(this.raw.POST('/screens/{screen_id}/reset', { params: { path: this.path }, body }))
  }

  readonly snapshots = {
    list: () => unwrap(this.raw.GET('/screens/{screen_id}/snapshots', { params: { path: this.path } })),
    create: (body: Schemas['SnapshotCreate'] = {}) =>
      unwrap(this.raw.POST('/screens/{screen_id}/snapshots', { params: { path: this.path }, body })),
    delete: async (snapshotId: string): Promise<void> => {
      await unwrap(
        this.raw.DELETE('/screens/{screen_id}/snapshots/{snapshot_id}', {
          params: { path: { ...this.path, snapshot_id: snapshotId } },
        }),
      )
    },
  }

  readonly operations = {
    list: (query: Query<'listOperations'> = {}) =>
      unwrap(this.raw.GET('/screens/{screen_id}/operations', { params: { path: this.path, query } })),
    all: (query: Omit<Query<'listOperations'>, 'after'> = {}) =>
      paginate((after) => this.operations.list({ ...query, after })),
  }

  /** A screenshot as JSON: base64 `data` and the `screenshot_id` to act on. */
  screenshot(query: Query<'getScreenshot'> = {}) {
    return unwrap(this.raw.GET('/screens/{screen_id}/screenshot', { params: { path: this.path, query } }))
  }
  /** A screenshot as image bytes. */
  screenshotImage(query: Query<'getScreenshotImage'> = {}) {
    return bytes(
      this.raw.GET('/screens/{screen_id}/screenshot/image', {
        params: { path: this.path, query },
        parseAs: 'arrayBuffer',
      }),
    )
  }
  /** A region of a screenshot at full resolution, `[x0, y0, x1, y1]` in that screenshot's pixels. */
  zoom(
    screenshotId: string,
    region: [number, number, number, number],
    query: Omit<Query<'getScreenshot'>, 'region' | 'screenshot_id'> = {},
  ) {
    return this.screenshot({ ...query, region: region.join(','), screenshot_id: screenshotId })
  }

  /**
   * The accessibility tree of the active window (or `window`, or `region`): elements with ids to act on by
   * `element`, `set_value` and `invoke`, bound to the reply's `screenshot_id` until the next input.
   */
  tree(query: Query<'getAccessibilityTree'> = {}) {
    return unwrap(this.raw.GET('/screens/{screen_id}/accessibility', { params: { path: this.path, query } }))
  }

  /** A batch of 1 to 20 actions, 100 ms apart, stopping at the first failure. */
  act(actions: Action[], opts: ActOptions = {}) {
    return unwrap(
      this.raw.POST('/screens/{screen_id}/actions', { params: { path: this.path }, body: { ...opts, actions } }),
    )
  }
  click(body: Schemas['ClickRequest']) {
    return unwrap(this.raw.POST('/screens/{screen_id}/click', { params: { path: this.path }, body }))
  }
  type(body: Schemas['TypeRequest']) {
    return unwrap(this.raw.POST('/screens/{screen_id}/type', { params: { path: this.path }, body }))
  }
  press(body: Schemas['PressRequest']) {
    return unwrap(this.raw.POST('/screens/{screen_id}/press', { params: { path: this.path }, body }))
  }
  scroll(body: Schemas['ScrollRequest']) {
    return unwrap(this.raw.POST('/screens/{screen_id}/scroll', { params: { path: this.path }, body }))
  }
  drag(body: Schemas['DragRequest']) {
    return unwrap(this.raw.POST('/screens/{screen_id}/drag', { params: { path: this.path }, body }))
  }
  move(body: Schemas['MoveRequest']) {
    return unwrap(this.raw.POST('/screens/{screen_id}/move', { params: { path: this.path }, body }))
  }
  /** Pauses on the screen, split into waits the API accepts (20 s each). */
  async wait(ms: number, opts: ActOptions = {}): Promise<ActionsResponse> {
    let left = Math.max(0, Math.round(ms))
    for (;;) {
      const chunk = Math.min(left, MAX_WAIT_ACTION_MS)
      left -= chunk
      if (left === 0) return this.act([{ type: 'wait', ms: chunk }], opts)
      await this.act([{ type: 'wait', ms: chunk }])
    }
  }
  /** Waits until the screen is quiet for `quiet_ms`, at most `max_ms`. */
  settle(opts: Omit<Schemas['ActionSettle'], 'type'> & ActOptions = {}) {
    const { quiet_ms, max_ms, ...rest } = opts
    return this.act([{ type: 'settle', quiet_ms, max_ms }], rest)
  }

  /** Runs a command. Short ones answer finished; long ones answer `running` with an id for `waitForExec`. */
  exec(body: Schemas['ExecCreate']) {
    return unwrap(this.raw.POST('/screens/{screen_id}/exec', { params: { path: this.path }, body }))
  }
  readonly execs = {
    /** Status and output from byte offsets. With `wait_s` the reply waits for the exit (or output). */
    get: (execId: string, query: Query<'getExec'> = {}, signal?: AbortSignal) =>
      unwrap(
        this.raw.GET('/screens/{screen_id}/exec/{exec_id}', {
          params: { path: { ...this.path, exec_id: execId }, query },
          signal,
        }),
      ),
    kill: (execId: string, body: Schemas['ExecKill'] = {}) =>
      unwrap(
        this.raw.POST('/screens/{screen_id}/exec/{exec_id}/kill', {
          params: { path: { ...this.path, exec_id: execId } },
          body,
        }),
      ),
  }
  /** Long-polls until the command is no longer running; reading never reruns it. */
  async waitForExec(
    execId: string,
    {
      timeoutMs = DEFAULT_TIMEOUT_MS,
      signal,
      ...query
    }: WaitOptions & Pick<Query<'getExec'>, 'max_bytes' | 'tail'> = {},
  ): Promise<Exec> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const wait_s = pollSeconds(deadline - Date.now())
      const ex = await this.execs.get(execId, { ...query, until: 'exit', wait_s }, signal)
      if (ex.status !== 'running') return ex
      if (Date.now() >= deadline)
        throw new KubiTimeoutError(`Kubi: exec ${execId} is still running after ${timeoutMs} ms`, ex)
    }
  }

  readonly files = {
    /** Writes `data` to `path` on the screen, up to 64 MiB. */
    upload: (path: string, data: Upload, opts: Omit<Query<'uploadFile'>, 'path'> = {}) =>
      unwrap(
        this.raw.PUT('/screens/{screen_id}/files', {
          params: { path: this.path, query: { ...opts, path } },
          body: data as unknown as string,
          bodySerializer: (b) => b,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      ),
    download: (path: string) =>
      bytes(
        this.raw.GET('/screens/{screen_id}/files', {
          params: { path: this.path, query: { path } },
          parseAs: 'arrayBuffer',
        }),
      ),
    /** One page of a folder. */
    list: (path: string, query: Omit<Query<'listFiles'>, 'path'> = {}) =>
      unwrap(this.raw.GET('/screens/{screen_id}/dir', { params: { path: this.path, query: { ...query, path } } })),
    all: (path: string, query: Omit<Query<'listFiles'>, 'path' | 'after'> = {}) =>
      paginate((after) => this.files.list(path, { ...query, after })),
  }

  readonly clipboard = {
    /** The clipboard's text, up to 100,000 characters; `truncated` says when there was more. Needs `control`. */
    get: () => unwrap(this.raw.GET('/screens/{screen_id}/clipboard', { params: { path: this.path } })),
    /** Puts text on the clipboard without pasting it; to paste, use `type` with `via: "paste"`. */
    set: (body: Schemas['ClipboardSet']) =>
      unwrap(this.raw.PUT('/screens/{screen_id}/clipboard', { params: { path: this.path }, body })),
  }

  /** A live-view link: open within 60 s, single use. Links agents make are view-only. */
  viewerLink(body: Schemas['ViewerCreate'] = {}) {
    return unwrap(this.raw.POST('/screens/{screen_id}/viewer', { params: { path: this.path }, body }))
  }

  readonly history = {
    /** One page of the screen's calls, newest first. */
    list: (query: Query<'listHistory'> = {}, signal?: AbortSignal) =>
      unwrap(this.raw.GET('/screens/{screen_id}/history', { params: { path: this.path, query }, signal })),
    all: (query: Omit<Query<'listHistory'>, 'after' | 'since' | 'wait_s'> = {}) =>
      paginate((after) => this.history.list({ ...query, after })),
    /** A saved screenshot's image bytes. */
    screenshot: (screenshotId: string) =>
      bytes(
        this.raw.GET('/screens/{screen_id}/screenshots/{screenshot_id}', {
          params: { path: { ...this.path, screenshot_id: screenshotId } },
          parseAs: 'arrayBuffer',
        }),
      ),
  }

  /**
   * New history rows as they are written, oldest first, from `since` (a row id) or from now. Runs until the loop
   * breaks or `signal` aborts.
   */
  async *followHistory(
    opts: Omit<Query<'listHistory'>, 'after' | 'wait_s' | 'limit'> & { signal?: AbortSignal } = {},
  ): AsyncGenerator<HistoryEntry> {
    let { since, signal, ...filters } = opts
    try {
      if (!since) since = (await this.history.list({ ...filters, limit: 1 }, signal)).data[0]?.id
      while (!signal?.aborted) {
        const page = await this.history.list({ ...filters, since, wait_s: MAX_WAIT_S }, signal)
        // Without a row to start from the API answers newest first; follow mode is oldest first.
        const rows: HistoryEntry[] = since ? page.data : [...page.data].reverse()
        for (const row of rows) {
          since = row.id
          yield row
        }
      }
    } catch (e) {
      if (!signal?.aborted) throw e
    }
  }
}
