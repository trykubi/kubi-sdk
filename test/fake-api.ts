// A fake Kubi API for the tests, built from the public spec. Every request the SDK sends is checked against the
// spec (the path and method exist, required parameters are there, every parameter and body validates against its
// schema, no parameter the spec doesn't name), and every reply is spec-shaped: the operation's own example unless a
// test scripts another, and a scripted reply is validated against the response schema for its status too.
import { readFileSync } from 'node:fs'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { parse } from 'yaml'

// biome-ignore lint/suspicious/noExplicitAny: the spec is plain parsed YAML.
type Json = any
export const spec: Json = parse(
  readFileSync(new URL('../spec/screens-v1.public.openapi.yaml', import.meta.url), 'utf8'),
)
export const BASE = 'https://api.trykubi.com/v1'

const ajv = new Ajv2020({ strict: false, validateFormats: false, validateSchema: false, allErrors: true })
ajv.addSchema(spec, 'spec')
const compiled = new WeakMap<object, ValidateFunction>()

/** Points local refs at the spec added to ajv, so an inline schema can be compiled on its own. */
function rebase(s: Json): Json {
  if (Array.isArray(s)) return s.map(rebase)
  if (s && typeof s === 'object')
    return Object.fromEntries(
      Object.entries(s).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' ? `spec${v}` : rebase(v)]),
    )
  return s
}

function deref(s: Json): Json {
  while (s?.$ref)
    s = s.$ref
      .slice(2)
      .split('/')
      .reduce((o: Json, k: string) => o[k.replace(/~1/g, '/')], spec)
  return s
}

/** The schema errors of a value, as text; empty when it validates. */
export function schemaErrors(schema: Json, value: unknown): string[] {
  let v = compiled.get(schema)
  if (!v) {
    v = ajv.compile(rebase(schema))
    compiled.set(schema, v)
  }
  return v(value) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`)
}

function types(s: Json): string[] {
  s = deref(s)
  const t = s.type ?? (s.const !== undefined ? typeof s.const : undefined)
  if (t) return Array.isArray(t) ? t : [t]
  return [...(s.anyOf ?? []), ...(s.oneOf ?? [])].flatMap(types)
}

/** Query and path values arrive as strings: turn them into what their schema says. */
function coerce(raw: string[], schema: Json): unknown {
  const t = types(schema)
  if (t.includes('array')) return raw.map((r) => coerce([r], deref(schema).items))
  const v = raw[0]
  if ((t.includes('integer') || t.includes('number')) && /^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if (t.includes('boolean') && (v === 'true' || v === 'false')) return v === 'true'
  return v
}

interface Route {
  template: string
  re: RegExp
  names: string[]
}
const routes: Route[] = Object.keys(spec.paths).map((template) => {
  const names: string[] = []
  const re = template.replace(/\{([^}]+)\}/g, (_, n) => {
    names.push(n)
    return '([^/]+)'
  })
  return { template, re: new RegExp(`^${re}$`), names }
})

/** Every operation in the spec, by operationId, but the WebSockets (a 101 reply: the live view, which noVNC opens). */
export const operationIds: string[] = Object.values(spec.paths).flatMap((item: Json) =>
  Object.values(item)
    .filter((op: Json) => !op.responses?.['101'])
    .map((op: Json) => op.operationId),
)

export interface Call {
  op: string
  method: string
  path: Record<string, string>
  query: URLSearchParams
  headers: Headers
  body: unknown
}
export interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}
type Scripted = Reply | ((call: Call) => Reply | undefined)

const ALWAYS_ALLOWED = new Set(['authorization', 'content-type', 'user-agent', 'kubi-run'])
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function findOperation(method: string, url: URL): { route: Route; op: Json; path: Record<string, string> } {
  if (!url.href.startsWith(`${BASE}/`)) throw new Error(`not under ${BASE}: ${url.href}`)
  const rel = url.pathname.slice(new URL(BASE).pathname.length)
  for (const route of routes) {
    const m = route.re.exec(rel)
    if (!m) continue
    const op = spec.paths[route.template][method.toLowerCase()]
    if (!op) throw new Error(`${method} ${route.template} is not in the spec`)
    const path = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]))
    return { route, op, path }
  }
  throw new Error(`no path in the spec matches ${rel}`)
}

/** The request's problems against the spec; empty when it conforms. */
async function check(req: Request, op: Json, route: Route, path: Record<string, string>, url: URL) {
  const problems: string[] = []
  const item = spec.paths[route.template]
  const params: Json[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref)
  for (const p of params) {
    let raw: string[] | undefined
    if (p.in === 'path') raw = path[p.name] === undefined ? undefined : [path[p.name]]
    if (p.in === 'query') raw = url.searchParams.has(p.name) ? url.searchParams.getAll(p.name) : undefined
    if (p.in === 'header') raw = req.headers.has(p.name) ? [req.headers.get(p.name) as string] : undefined
    if (raw === undefined) {
      if (p.required) problems.push(`missing required ${p.in} parameter ${p.name}`)
      continue
    }
    for (const e of schemaErrors(p.schema, coerce(raw, p.schema))) problems.push(`${p.in} ${p.name}: ${e}`)
  }
  const named = (where: string) => new Set(params.filter((p) => p.in === where).map((p) => p.name.toLowerCase()))
  const queryNames = named('query')
  for (const k of new Set(url.searchParams.keys()))
    if (!queryNames.has(k.toLowerCase())) problems.push(`query parameter ${k} is not in the spec`)
  const headerNames = named('header')
  for (const [k] of req.headers) {
    if (headerNames.has(k) || ALWAYS_ALLOWED.has(k)) continue
    // The SDK sends a key on every changing call; the spec names it on POSTs.
    if (k === 'idempotency-key' && MUTATING.has(req.method)) continue
    problems.push(`header ${k} is not in the spec`)
  }
  const secured = (op.security ?? spec.security ?? []).length > 0
  if (secured && !/^Bearer \S+$/.test(req.headers.get('authorization') ?? '')) problems.push('no Bearer credential')

  const raw = new Uint8Array(await req.clone().arrayBuffer())
  let body: unknown
  if (!op.requestBody) {
    if (raw.length) problems.push('a body where the spec has none')
  } else if (!raw.length) {
    if (op.requestBody.required) problems.push('the spec requires a body')
  } else {
    const type = (req.headers.get('content-type') ?? '').split(';')[0].trim()
    const media = op.requestBody.content[type]
    if (!media) problems.push(`content type ${type || '(none)'} is not in the spec`)
    else if (type === 'application/json') {
      body = JSON.parse(new TextDecoder().decode(raw))
      for (const e of schemaErrors(media.schema, body)) problems.push(`body ${e}`)
    } else body = raw
  }
  return { problems, body }
}

function successStatus(op: Json): number {
  return Number(Object.keys(op.responses).find((c) => c.startsWith('2')))
}

/** The spec's own example reply for an operation's success. */
export function example(opId: string, status?: number): Json {
  const op = Object.values(spec.paths)
    .flatMap((item: Json) => Object.values(item))
    .find((o: Json) => o.operationId === opId) as Json
  const res = deref(op.responses[status ?? successStatus(op)])
  const json = res.content?.['application/json']
  if (!json) return undefined
  const ex = json.example ?? Object.values(json.examples ?? {})[0]
  return structuredClone((ex as Json)?.value ?? ex)
}

export function apiError(
  status: number,
  code: string,
  opts: { retryable?: boolean; retry_after?: number | null; outcome?: string; headers?: Record<string, string> } = {},
): Reply {
  return {
    status,
    headers: opts.headers,
    body: {
      error: {
        code,
        message: `${code}. Do the fix.`,
        request_id: 'req_0123456789abcdefghij',
        retryable: opts.retryable ?? false,
        retry_after: opts.retry_after ?? null,
        outcome: opts.outcome ?? 'not_applied',
      },
    },
  }
}

export function fakeApi() {
  const queues = new Map<string, Scripted[]>()
  const calls: Call[] = []
  const problems: string[] = []
  const fail = (msg: string) => {
    problems.push(msg)
    return new Error(`fake api: ${msg}`)
  }

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    let found: ReturnType<typeof findOperation>
    try {
      found = findOperation(req.method, url)
    } catch (e) {
      throw fail((e as Error).message)
    }
    const { route, op, path } = found
    const where = `${op.operationId} (${req.method} ${route.template})`
    const { problems: bad, body } = await check(req, op, route, path, url)
    if (bad.length) throw fail(`${where}: ${bad.join('; ')}`)
    const call: Call = {
      op: op.operationId,
      method: req.method,
      path,
      query: url.searchParams,
      headers: req.headers,
      body,
    }
    calls.push(call)

    const next = queues.get(op.operationId)?.shift()
    const reply = (typeof next === 'function' ? next(call) : next) ?? {}
    const status = reply.status ?? successStatus(op)
    const declared = op.responses[String(status)]
    if (!declared) throw fail(`${where}: status ${status} is not in the spec`)
    const res = deref(declared)
    const types = Object.keys(res.content ?? {})
    const headers = new Headers(reply.headers)
    if (!types.length) return new Response(null, { status, headers })
    if (types[0] !== 'application/json') {
      headers.set('content-type', types[0])
      return new Response((reply.body as BodyInit | undefined) ?? new Uint8Array([1, 2, 3]), { status, headers })
    }
    const out = reply.body === undefined ? example(op.operationId, status) : reply.body
    const errors = schemaErrors(res.content['application/json'].schema, out)
    if (errors.length) throw fail(`${where}: reply ${status} does not match the spec: ${errors.join('; ')}`)
    headers.set('content-type', 'application/json')
    return new Response(JSON.stringify(out), { status, headers })
  }

  const api = {
    calls,
    problems,
    fetch: fetch as unknown as typeof globalThis.fetch,
    /** Scripts the next replies of one operation, in order; after them it answers the spec's example. */
    on(opId: string, ...replies: Scripted[]) {
      if (!operationIds.includes(opId)) throw new Error(`unknown operation ${opId}`)
      queues.set(opId, [...(queues.get(opId) ?? []), ...replies])
      return api
    },
    ops: () => calls.map((c) => c.op),
  }
  return api
}
