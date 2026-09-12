/**
 * Small, deterministic RFC 9309 robots.txt parser and matcher.
 *
 * This module intentionally does not fetch robots.txt and does not make any
 * product-specific decision about a crawler.  The caller supplies the
 * crawler's product token and the paths that are in scope for the audit.
 */

export type RobotsRule = {
  allow: boolean
  path: string
}

export type RobotsGroup = {
  agents: string[]
  rules: RobotsRule[]
}

export type RobotsPathResult = {
  path: string
  allowed: boolean
}

export type RobotsEvaluation = {
  policy: 'allowed' | 'restricted' | 'mixed'
  results: RobotsPathResult[]
}

export type RobotsRuleMatch = {
  path: string
  allowed: boolean
  matched_rule: RobotsRule | null
}

export type RobotsEvaluationWithRules = {
  policy: 'allowed' | 'restricted' | 'mixed'
  results: RobotsRuleMatch[]
}

const PRODUCT_TOKEN = /^[A-Za-z_-]+$/
const UNRESERVED = /^[A-Za-z0-9._~-]$/
const HEX = /^[0-9A-Fa-f]{2}$/

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

function stripComment(value: string): string {
  const commentStart = value.indexOf('#')
  return commentStart >= 0 ? value.slice(0, commentStart) : value
}

function splitField(line: string): { key: string; value: string } | null {
  const separator = line.indexOf(':')
  if (separator < 0) return null
  return {
    key: line.slice(0, separator).trim().toLowerCase(),
    value: line.slice(separator + 1).trim(),
  }
}

function isProductToken(value: string): boolean {
  return value === '*' || PRODUCT_TOKEN.test(value)
}

/**
 * Parse the explicitly defined RFC 9309 records.  Empty lines, comments and
 * extension records do not terminate a group.  A new user-agent line starts
 * a new group only after the current group has received a rule; otherwise it
 * adds another agent to the current group.
 */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | null = null
  const source = stripBom(text)

  for (const rawLine of source.split(/\r\n|\n|\r/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue
    const field = splitField(line)
    if (!field) continue

    if (field.key === 'user-agent') {
      if (!isProductToken(field.value)) continue
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      const normalizedAgent = field.value.toLowerCase()
      if (!current.agents.some((agent) => agent === normalizedAgent)) {
        current.agents.push(normalizedAgent)
      }
      continue
    }

    if (field.key !== 'allow' && field.key !== 'disallow') continue
    if (!current) continue

    // An empty-pattern line is valid syntax and still belongs to this group.
    // Keep it as a no-op rule so a following User-agent starts a new group.
    current.rules.push({ allow: field.key === 'allow', path: field.value })
  }

  return groups
}

function looksLikeHtml(value: string): boolean {
  const sample = stripBom(value).replace(/^[\u0009\u000a\u000d\u0020]+/, '').slice(0, 1024).toLowerCase()
  const withoutRobotsComments = sample.split(/\r\n|\n|\r/).map((line) => stripComment(line)).join('\n').replace(/^[\u0009\u000a\u000d\u0020]+/, '')
  return /^(?:<!doctype\s+html\b|<!--[\s\S]*?-->|<html(?:[\s>]|$)|<head(?:[\s>]|$)|<body(?:[\s>]|$)|<meta(?:[\s>]|$)|<title(?:[\s>]|$)|<script(?:[\s>]|$)|<style(?:[\s>]|$)|<div(?:[\s>]|$)|<main(?:[\s>]|$)|<section(?:[\s>]|$)|<table(?:[\s>]|$)|<svg(?:[\s>]|$))/.test(withoutRobotsComments)
}

function hasBinaryControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0xfffd || code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) return true
  }
  return false
}

/**
 * Reject obvious HTML/binary bodies while accepting valid empty, whitespace or
 * comment-only robots files.  Content-type and HTTP status belong to the
 * caller; this function only inspects the decoded body.
 */
export function isRobotsText(text: string): boolean {
  if (typeof text !== 'string') return false
  if (hasBinaryControl(text) || looksLikeHtml(text)) return false
  return true
}

function utf8PercentEncode(value: string): string {
  let result = ''
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) {
      result += character
      continue
    }
    result += encodeURIComponent(character).replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase())
  }
  return result
}

/**
 * Normalize both a robots rule and a request path to the RFC comparison form.
 * Existing percent escapes are retained except for percent-encoded unreserved
 * ASCII, which is decoded.  Reserved escapes such as %2F remain escapes.
 */
function normalizePath(value: string): string {
  let candidate = value.trim()
  try {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate)) {
      const url = new URL(candidate)
      candidate = `${url.pathname}${url.search}`
    }
  } catch {
    // Treat malformed URL-like input as an already supplied path.
  }

  candidate = utf8PercentEncode(candidate)
  let result = ''
  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index]
    if (character === '%' && index + 2 < candidate.length) {
      const hex = candidate.slice(index + 1, index + 3)
      if (HEX.test(hex)) {
        const byte = Number.parseInt(hex, 16)
        const decoded = String.fromCharCode(byte)
        if (byte < 0x80 && UNRESERVED.test(decoded)) result += decoded
        else result += `%${hex.toUpperCase()}`
        index += 2
        continue
      }
    }
    result += character
  }
  return result
}

function octetLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function globPrefixMatch(pattern: string, target: string, endAnchor: boolean): boolean {
  // Greedy-star matching with one backtracking position is linear in the
  // target for ordinary patterns and avoids constructing a user-controlled
  // regular expression.
  let patternIndex = 0
  let targetIndex = 0
  let starIndex = -1
  let starTargetIndex = -1

  while (targetIndex < target.length) {
    if (patternIndex >= pattern.length) {
      if (!endAnchor) return true
      // A trailing end anchor may still succeed after expanding the most
      // recent wildcard to consume the remaining target octets.
      if (starIndex >= 0 && starTargetIndex < target.length) {
        starTargetIndex += 1
        patternIndex = starIndex + 1
        targetIndex = starTargetIndex
        continue
      }
      return false
    }
    if (patternIndex < pattern.length && pattern[patternIndex] !== '*' && pattern[patternIndex] === target[targetIndex]) {
      patternIndex += 1
      targetIndex += 1
      continue
    }
    if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      starIndex = patternIndex
      starTargetIndex = targetIndex
      patternIndex += 1
      continue
    }
    if (starIndex >= 0) {
      patternIndex = starIndex + 1
      starTargetIndex += 1
      targetIndex = starTargetIndex
      continue
    }
    return false
  }

  // For a prefix rule the rule is satisfied as soon as its pattern has been
  // consumed.  With an end anchor, all target octets must also be consumed.
  while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex += 1
  return patternIndex === pattern.length && (!endAnchor || targetIndex === target.length)
}

function ruleMatches(rulePath: string, requestPath: string): boolean {
  const normalizedRule = normalizePath(rulePath)
  if (!normalizedRule) return false
  const normalizedRequest = normalizePath(requestPath)
  const endAnchor = normalizedRule.endsWith('$')
  const pattern = endAnchor ? normalizedRule.slice(0, -1) : normalizedRule
  return globPrefixMatch(pattern, normalizedRequest, endAnchor)
}

function groupMatchesAgent(group: RobotsGroup, agent: string): boolean {
  const normalizedAgent = agent.trim().toLowerCase()
  // The evaluator receives the crawler's exact product token.  RFC 9309
  // requires case-insensitive product-token matching; substring matching is
  // only guidance for how a token may appear in a full HTTP User-Agent value.
  return group.agents.some((candidate) => candidate.toLowerCase() === normalizedAgent)
}

/** Evaluate paths against the applicable merged RFC 9309 group. */
export function evaluateRobotsWithRules(groups: RobotsGroup[], agent: string, paths: string[]): RobotsEvaluationWithRules | null {
  const normalizedAgent = agent.trim().toLowerCase()
  // When the caller asks for the generic policy (`*`), only groups that
  // actually declare `*` are applicable.  A mixed declaration such as
  // `User-agent: *` + `User-agent: Foo` must not make unrelated generic groups
  // disappear merely because the same group also mentions a named token.
  const specific = normalizedAgent === '*'
    ? []
    : groups.filter((group) => groupMatchesAgent(group, agent) && group.agents.some((candidate) => candidate !== '*'))
  const applicable = specific.length > 0 ? specific : groups.filter((group) => group.agents.some((candidate) => candidate === '*'))
  if (applicable.length === 0) return null

  const rules = applicable.flatMap((group) => group.rules)
  const samples = paths.length ? paths : ['/']
  const results = samples.map((path) => {
    let bestLength = -1
    let bestAllow = true
    let matchedRule: RobotsRule | null = null
    for (const rule of rules) {
      if (!ruleMatches(rule.path, path)) continue
      const normalizedRule = normalizePath(rule.path).replace(/\$$/, '')
      const length = octetLength(normalizedRule)
      if (length > bestLength || (length === bestLength && rule.allow && !bestAllow)) {
        bestLength = length
        bestAllow = rule.allow
        matchedRule = rule
      }
    }
    return { path, allowed: bestAllow, matched_rule: matchedRule }
  })

  const blocked = results.filter((result) => !result.allowed).length
  return {
    policy: blocked === 0 ? 'allowed' : blocked === results.length ? 'restricted' : 'mixed',
    results,
  }
}

/** Evaluate paths while retaining the winning rule for evidence.  The public
 * legacy evaluator intentionally keeps its compact `{path, allowed}` shape so
 * callers that only need policy do not receive any unredacted rule data. */
export function evaluateRobots(groups: RobotsGroup[], agent: string, paths: string[]): RobotsEvaluation | null {
  const evaluation = evaluateRobotsWithRules(groups, agent, paths)
  if (!evaluation) return null
  return {
    policy: evaluation.policy,
    results: evaluation.results.map(({ path, allowed }) => ({ path, allowed })),
  }
}
