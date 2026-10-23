#!/usr/bin/env node
/**
 * Checks a running server against the edge contract (v2).
 *
 *   EDGE_TOKEN=<token> node scripts/edge-conformance.mjs <.output dir> <base url> \
 *     [--unlisted /path] [--guarded /path] [--sample '/posts/[slug]=/posts/hello'] \
 *     [--query '/search?q=edge-check']
 *
 * Framework-neutral on purpose: it reads only the marker and speaks only the
 * contract's endpoints, so any implementation - and the platform holding a
 * copy - can run it. The server must have been started with the same
 * EDGE_TOKEN; a second check is made without it.
 *
 * A listed pattern is checked only through a --sample, because which values
 * of a parameter render a page is the app's to say. --query names a listed
 * page whose holes print the value of the url's first query parameter, so
 * the check can see that a resume rendered for the visitor's query.
 *
 * --guarded names a page the framework must keep out: in neither list, and a
 * 404 from the page endpoint. The strongest one to name is a page whose
 * response a rule changes in a way an edge could not repeat - a middleware,
 * or a header rule setting a header off the contract's list.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [outDir, base, ...rest] = process.argv.slice(2)
const token = process.env.EDGE_TOKEN ?? ''
const flags = { unlisted: [], guarded: [], sample: [], query: [] }

for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, '')]?.push(rest[i + 1])

if (!outDir || !base || !token) {
  console.error('usage: EDGE_TOKEN=… edge-conformance.mjs <.output dir> <base url> [--unlisted p] [--guarded p] [--sample pattern=path] [--query url]')
  process.exit(2)
}

let failed = 0
const fail = (what) => {
  failed++
  console.log(`  ✗ ${what}`)
}
const pass = (what) => console.log(`  ✓ ${what}`)
const check = (ok, what) => (ok ? pass(what) : fail(what))

// The marker.
const file = join(outDir, 'edge.json')

if (!existsSync(file)) {
  console.log(`✗ no ${file}`)
  process.exit(1)
}

const marker = JSON.parse(readFileSync(file, 'utf8'))
const bytes = (s) => new TextEncoder().encode(s).length

console.log('marker')
check(marker.v === 2, 'v is 2')
check(typeof marker.build === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(marker.build), 'build is 1-128 bytes of [A-Za-z0-9._-]')
check(Array.isArray(marker.shells), 'shells is a list')
check(marker.shells.length <= 200, 'at most 200 shells')
check(new Set(marker.shells).size === marker.shells.length, 'no duplicates')
check(
  marker.shells.every(
    (p) =>
      typeof p === 'string' &&
      p.startsWith('/') &&
      bytes(p) <= 200 &&
      !/[?#]/.test(p) &&
      !p.includes('[[') &&
      (p === '/' || p.slice(1).split('/').every((s) => s !== '' && s !== '.' && s !== '..')) &&
      p.split('/').every((s, i, all) => !s.startsWith('[...') || i === all.length - 1),
  ),
  'every shell is an absolute, decoded path of at most 200 bytes, a catch-all only last',
)
const statics = marker.static ?? []
check(Array.isArray(statics), 'static is a list')
check(statics.length <= 200, 'at most 200 static')
check(new Set(statics).size === statics.length, 'no duplicate static')
check(
  statics.every(
    (p) =>
      typeof p === 'string' &&
      p.startsWith('/') &&
      bytes(p) <= 200 &&
      !/[?#[\]]/.test(p) &&
      (p === '/' || p.slice(1).split('/').every((s) => s !== '' && s !== '.' && s !== '..')),
  ),
  'every static is an absolute, decoded, concrete path of at most 200 bytes',
)
check(!statics.some((p) => marker.shells.includes(p)), 'no path is in both lists')
for (const list of ['headers', 'query', 'cookies']) {
  const names = marker.bypass?.[list] ?? []
  check(Array.isArray(names) && names.length <= 32, `bypass.${list} is at most 32 names`)
}

const shellOf = (path, headers = { 'Edge-Token': token }) =>
  fetch(`${base}/_edge/page?path=${encodeURIComponent(path)}`, { headers: { Accept: 'application/json', ...headers } })
const resumeOf = (url, state, headers = { 'Edge-Token': token }) =>
  fetch(`${base}/_edge/resume?url=${encodeURIComponent(url)}`, {
    method: 'POST',
    // As if the edge had forgotten to drop it: the resume must come back
    // plain regardless, or its bytes land compressed in the middle of a page.
    headers: { 'Content-Type': 'application/octet-stream', 'Accept-Encoding': 'gzip, br', ...headers },
    body: state,
  })
// The contract's `headers`: optional, from its list, at most 16, and what the
// page itself goes out with - an edge sends them with its copy.
const ALLOWED = new Set(
  [
    'Content-Language', 'Link', 'Cache-Control', 'X-Robots-Tag', 'Content-Security-Policy', 'Permissions-Policy',
    'Referrer-Policy', 'Strict-Transport-Security', 'X-Frame-Options', 'X-Content-Type-Options',
    'Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Cross-Origin-Resource-Policy', 'X-DNS-Prefetch-Control',
  ].map((name) => name.toLowerCase()),
)
const checkHeaders = (headers, direct) => {
  if (headers === undefined) return
  const entries = Object.entries(headers ?? {})
  check(
    headers !== null && typeof headers === 'object' && entries.length <= 16 && entries.every(([n, v]) => ALLOWED.has(n.toLowerCase()) && typeof v === 'string'),
    'headers are at most 16, each from the allowed list',
  )
  const differ = entries.filter(([n, v]) => direct.headers.get(n) !== v).map(([n]) => n)
  check(differ.length === 0, `and the page served directly has each${differ.length ? `: not ${differ.join(', ')}` : ''}`)
}

// Answered only for the token, so nothing on the way may keep it.
// The contract's `private, no-store`, both directives: `no-store` alone still
// lets a shared cache that ignores it keep a copy.
const unstored = (response) => {
  const directives = (response.headers.get('Cache-Control') ?? '').toLowerCase().split(',').map((d) => d.trim())

  return directives.includes('private') && directives.includes('no-store')
}
// A marker pattern against a path: `[name]` is one segment, a final `[...name]` one or more.
const matches = (pattern, path) => {
  const want = pattern.split('/')
  const have = path.split('/')

  for (const [i, part] of want.entries()) {
    if (i === want.length - 1 && /^\[\.\.\..+\]$/.test(part)) return have.length > i && have.slice(i).every(Boolean)
    if (have[i] === undefined || (/^\[.+\]$/.test(part) ? have[i] === '' : part !== have[i])) return false
  }

  return want.length === have.length
}

const samples = Object.fromEntries(flags.sample.map((s) => s.split('=')))
const paths = marker.shells.flatMap((p) => (p.includes('[') ? (samples[p] ? [samples[p]] : []) : [p]))

for (const path of paths) {
  console.log(path)

  const shell = await shellOf(path)

  if (shell.status !== 200) {
    fail(`shell is ${shell.status}, not 200`)
    continue
  }

  check(shell.headers.get('Edge-Build') === marker.build, 'shell says the marker\'s build')
  check(unstored(shell), 'shell is Cache-Control: private, no-store')
  const body = await shell.json()
  check(body.v === 2 && body.build === marker.build && typeof body.html === 'string' && typeof body.state === 'string', 'shell is { v, build, html, state }')
  check(!body.complete, 'and not complete')

  const etag = shell.headers.get('ETag')
  if (etag) check((await shellOf(path, { 'Edge-Token': token, 'If-None-Match': etag })).status === 304, 'If-None-Match is a 304')

  const resumed = await resumeOf(path, body.state)
  const holes = await resumed.text()
  check(resumed.status === 200, `resume is ${resumed.status}`)
  check((resumed.headers.get('Content-Type') ?? '').startsWith('text/html'), 'resume is text/html')
  check(resumed.headers.get('Edge-Build') === marker.build, 'resume says the marker\'s build')
  check(unstored(resumed), 'resume is Cache-Control: private, no-store')
  check(!resumed.headers.get('Content-Encoding'), 'resume is not compressed, though the request accepted gzip')
  check(!/<!DOCTYPE|<html[\s>]/i.test(holes), 'resume never starts a second document')

  const page = body.html + holes
  check(/^\s*<!DOCTYPE html>/i.test(page) && /<\/html>\s*$/i.test(page) && (page.match(/<html[\s>]/gi) ?? []).length === 1, 'shell + holes is one document')

  const served = await fetch(`${base}${encodeURI(path)}`, { headers: { Accept: 'text/html' } })
  const direct = await served.text()
  const title = (html) => html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? null
  check(title(page) === title(direct), 'and it is the page served directly (by its title)')
  checkHeaders(body.headers, served)
}

// A static page: whole, the page itself, and able to boot from the edge
// alone - everything its document links is an immutable asset, so nothing it
// needs is a request the edge passes to the app.
for (const path of statics) {
  console.log(`${path} (static)`)

  const answer = await shellOf(path)

  if (answer.status !== 200) {
    fail(`page is ${answer.status}, not 200`)
    continue
  }

  check(answer.headers.get('Edge-Build') === marker.build, 'page says the marker\'s build')
  check(unstored(answer), 'page is Cache-Control: private, no-store')
  const body = await answer.json()
  check(body.v === 2 && body.build === marker.build && body.complete === true && body.state === '', 'page is { v, build, html, state: "", complete: true }')
  check(/^\s*<!DOCTYPE html>/i.test(body.html) && /<\/html>\s*$/i.test(body.html), 'html is a whole document')

  // A static page can change while the build stands too (an on-demand
  // revalidation), and then it says so with an ETag.
  const etag = answer.headers.get('ETag')
  if (etag) check((await shellOf(path, { 'Edge-Token': token, 'If-None-Match': etag })).status === 304, 'If-None-Match is a 304')

  const direct = await fetch(`${base}${encodeURI(path)}`, { headers: { Accept: 'text/html' } })
  check(direct.status === 200 && (await direct.text()) === body.html, 'and it is the page served directly, byte for byte')
  checkHeaders(body.headers, direct)

  // What it needs to become interactive: scripts, styles and anything it
  // preloads (rsc-kit's stored payload is one). An icon or a manifest is not.
  const tags = body.html.match(/<(?:script|link)\b[^>]*>/gi) ?? []
  const linked = tags
    .filter((tag) => /^<script/i.test(tag) || /\srel="(?:stylesheet|modulepreload|preload)"/i.test(tag))
    .map((tag) => tag.match(/\s(?:src|href)="([^"]+)"/i)?.[1])
    .filter(Boolean)
    .map((href) => href.replace(/&amp;/g, '&'))
    .filter((href) => href.startsWith('/') && !href.startsWith('//'))
  const mutable = []

  for (const href of new Set(linked)) {
    const asset = await fetch(`${base}${href}`)
    await asset.arrayBuffer()
    if (asset.status !== 200 || !/immutable/.test(asset.headers.get('Cache-Control') ?? '')) mutable.push(`${href} (${asset.status})`)
  }

  check(mutable.length === 0, `every script, style and preload it links is an immutable asset${mutable.length ? `: not ${mutable.join(', ')}` : ''}`)
}

for (const url of flags.query) {
  console.log(url)

  const { pathname, searchParams } = new URL(url, 'http://x')
  const value = [...searchParams.values()][0]
  const { state } = await (await shellOf(decodeURIComponent(pathname))).json()
  const holes = await (await resumeOf(url, state)).text()

  check(Boolean(value) && holes.includes(value), `the holes were rendered for the visitor's query (${value})`)
}

console.log('refusals')
const first = paths[0] ?? '/'
const refused = await shellOf(first, {})
check(refused.status === 404, 'a page without Edge-Token is a 404')
check(unstored(refused), 'and the 404 is Cache-Control: private, no-store too')
check((await shellOf(first, { 'Edge-Token': `${token}x` })).status === 404, 'a page with a wrong Edge-Token is a 404')
check((await resumeOf(first, '', {})).status === 404, 'a resume without Edge-Token is a 404')
const unknown = await fetch(`${base}/_edge/nothing?path=${encodeURIComponent(first)}`, { headers: { 'Edge-Token': token } })
check(unknown.status === 404, 'any other path under /_edge/, with the token, is a 404')
check(unstored(unknown), 'and private, no-store too')
// A static page is whole: it has no holes, so nothing to resume.
if (statics[0]) check((await resumeOf(statics[0], '')).status === 404, `a resume for static ${statics[0]} is a 404`)
for (const path of flags.unlisted) check((await shellOf(path)).status === 404, `unlisted ${path} is a 404`)
for (const path of flags.guarded) {
  check(!statics.includes(path) && !marker.shells.some((pattern) => matches(pattern, path)), `guarded ${path} is in neither list`)
  check((await shellOf(path)).status === 404, `guarded ${path} is a 404`)
}

console.log(failed ? `\n${failed} failed` : '\nconforms')
process.exit(failed ? 1 : 0)
