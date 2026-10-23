#!/usr/bin/env node
/**
 * Checks a running server against the PPR contract (v1).
 *
 *   PPR_TOKEN=<token> node scripts/ppr-conformance.mjs <.output dir> <base url> \
 *     [--unlisted /path] [--guarded /path] [--sample '/posts/[slug]=/posts/hello'] \
 *     [--query '/search?q=ppr-check']
 *
 * Framework-neutral on purpose: it reads only the marker and speaks only the
 * contract's endpoints, so any implementation - and the platform holding a
 * copy - can run it. The server must have been started with the same
 * PPR_TOKEN; a second check is made without it.
 *
 * A listed pattern is checked only through a --sample, because which values
 * of a parameter render a page is the app's to say. --query names a listed
 * page whose holes print the value of the url's first query parameter, so
 * the check can see that a resume rendered for the visitor's query.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [outDir, base, ...rest] = process.argv.slice(2)
const token = process.env.PPR_TOKEN ?? ''
const flags = { unlisted: [], guarded: [], sample: [], query: [] }

for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, '')]?.push(rest[i + 1])

if (!outDir || !base || !token) {
  console.error('usage: PPR_TOKEN=… ppr-conformance.mjs <.output dir> <base url> [--unlisted p] [--guarded p] [--sample pattern=path] [--query url]')
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
const file = join(outDir, 'ppr.json')

if (!existsSync(file)) {
  console.log(`✗ no ${file}`)
  process.exit(1)
}

const marker = JSON.parse(readFileSync(file, 'utf8'))
const bytes = (s) => new TextEncoder().encode(s).length

console.log('marker')
check(marker.v === 1, 'v is 1')
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
for (const list of ['headers', 'query', 'cookies']) {
  const names = marker.bypass?.[list] ?? []
  check(Array.isArray(names) && names.length <= 32, `bypass.${list} is at most 32 names`)
}

const shellOf = (path, headers = { 'PPR-Token': token }) =>
  fetch(`${base}/_ppr/shell?path=${encodeURIComponent(path)}`, { headers: { Accept: 'application/json', ...headers } })
const resumeOf = (url, state, headers = { 'PPR-Token': token }) =>
  fetch(`${base}/_ppr/resume?url=${encodeURIComponent(url)}`, {
    method: 'POST',
    // As if the edge had forgotten to drop it: the resume must come back
    // plain regardless, or its bytes land compressed in the middle of a page.
    headers: { 'Content-Type': 'application/octet-stream', 'Accept-Encoding': 'gzip, br', ...headers },
    body: state,
  })
// Answered only for the token, so nothing on the way may keep it.
const unstored = (response) => /no-store/.test(response.headers.get('Cache-Control') ?? '')

const samples = Object.fromEntries(flags.sample.map((s) => s.split('=')))
const paths = marker.shells.flatMap((p) => (p.includes('[') ? (samples[p] ? [samples[p]] : []) : [p]))

for (const path of paths) {
  console.log(path)

  const shell = await shellOf(path)

  if (shell.status !== 200) {
    fail(`shell is ${shell.status}, not 200`)
    continue
  }

  check(shell.headers.get('PPR-Build') === marker.build, 'shell says the marker\'s build')
  check(unstored(shell), 'shell is Cache-Control: no-store')
  const body = await shell.json()
  check(body.v === 1 && body.build === marker.build && typeof body.html === 'string' && typeof body.state === 'string', 'shell is { v, build, html, state }')

  const etag = shell.headers.get('ETag')
  if (etag) check((await shellOf(path, { 'PPR-Token': token, 'If-None-Match': etag })).status === 304, 'If-None-Match is a 304')

  const resumed = await resumeOf(path, body.state)
  const holes = await resumed.text()
  check(resumed.status === 200, `resume is ${resumed.status}`)
  check((resumed.headers.get('Content-Type') ?? '').startsWith('text/html'), 'resume is text/html')
  check(resumed.headers.get('PPR-Build') === marker.build, 'resume says the marker\'s build')
  check(unstored(resumed), 'resume is Cache-Control: no-store')
  check(!resumed.headers.get('Content-Encoding'), 'resume is not compressed, though the request accepted gzip')
  check(!/<!DOCTYPE|<html[\s>]/i.test(holes), 'resume never starts a second document')

  const page = body.html + holes
  check(/^\s*<!DOCTYPE html>/i.test(page) && /<\/html>\s*$/i.test(page) && (page.match(/<html[\s>]/gi) ?? []).length === 1, 'shell + holes is one document')

  const direct = await (await fetch(`${base}${encodeURI(path)}`, { headers: { Accept: 'text/html' } })).text()
  const title = (html) => html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? null
  check(title(page) === title(direct), 'and it is the page served directly (by its title)')
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
check(refused.status === 404, 'a shell without PPR-Token is a 404')
check(unstored(refused), 'and the 404 is Cache-Control: no-store too')
check((await shellOf(first, { 'PPR-Token': `${token}x` })).status === 404, 'a shell with a wrong PPR-Token is a 404')
check((await resumeOf(first, '', {})).status === 404, 'a resume without PPR-Token is a 404')
for (const path of flags.unlisted) check((await shellOf(path)).status === 404, `unlisted ${path} is a 404`)
for (const path of flags.guarded) check((await shellOf(path)).status === 404, `guarded ${path} is a 404`)

console.log(failed ? `\n${failed} failed` : '\nconforms')
process.exit(failed ? 1 : 0)
