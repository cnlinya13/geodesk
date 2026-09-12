import { describe, expect, it } from 'vitest'
import { evaluateRobots, evaluateRobotsWithRules, isRobotsText, parseRobots, type RobotsGroup } from './technical-audit-robots'

describe('RFC 9309 robots parser', () => {
  it('parses dedicated and general groups and falls back to * only without a dedicated group', () => {
    const groups = parseRobots(`
      User-agent: *
      Disallow: /general

      User-agent: GPTBot
      Allow: /public
      Disallow: /private
    `)

    expect(groups).toEqual([
      { agents: ['*'], rules: [{ allow: false, path: '/general' }] },
      { agents: ['gptbot'], rules: [{ allow: true, path: '/public' }, { allow: false, path: '/private' }] },
    ])
    expect(evaluateRobots(groups, 'gPtBoT', ['/private'])).toMatchObject({ policy: 'restricted', results: [{ allowed: false }] })
    expect(evaluateRobots(groups, 'OtherBot', ['/general'])).toMatchObject({ policy: 'restricted', results: [{ allowed: false }] })
    expect(evaluateRobots(groups, 'OtherBot', ['/private'])).toMatchObject({ policy: 'allowed', results: [{ allowed: true }] })
  })

  it('combines repeated matching groups and keeps blank lines, comments and extension records inside a group', () => {
    const groups = parseRobots(`﻿User-agent: GPTBot # first declaration
      # this comment is not a group boundary
      Sitemap: https://example.test/sitemap.xml
      Disallow: /one

      User-agent: GPTBot
      Allow: /one/public
      User-agent: AnotherBot
      Disallow: /two
    `)

    expect(groups).toHaveLength(3)
    expect(groups[0]).toEqual({
      agents: ['gptbot'],
      rules: [{ allow: false, path: '/one' }],
    })
    expect(groups[1]).toEqual({
      agents: ['gptbot'],
      rules: [{ allow: true, path: '/one/public' }],
    })
    expect(groups[2]).toEqual({ agents: ['anotherbot'], rules: [{ allow: false, path: '/two' }] })
    expect(evaluateRobots(groups, 'GPTBot', ['/one', '/one/public'])).toMatchObject({
      policy: 'mixed',
      results: [{ path: '/one', allowed: false }, { path: '/one/public', allowed: true }],
    })
  })

  it('uses the longest match and Allow on equal-length conflicts', () => {
    const groups = parseRobots(`User-agent: *
      Disallow: /example/page/
      Disallow: /example/page/disallowed.gif
      Allow: /same
      Disallow: /same
    `)

    const result = evaluateRobots(groups, 'Crawler', ['/example/page/disallowed.gif', '/example/page/ok', '/same'])
    expect(result).toEqual({
      policy: 'mixed',
      results: [
        { path: '/example/page/disallowed.gif', allowed: false },
        { path: '/example/page/ok', allowed: false },
        { path: '/same', allowed: true },
      ],
    })
  })

  it('supports BOM, wildcard and end-anchor rules without regex backtracking', () => {
    const groups = parseRobots(`﻿User-agent: *
      Disallow: *.gif$
      Disallow: /a*b$
      Allow: /assets/*/public$
    `)
    const result = evaluateRobots(groups, 'Crawler', ['/image.gif', '/image.gif?size=large', '/a', '/abxb', '/assets/a/public', '/assets/a/public/extra'])
    expect(result).toEqual({
      policy: 'mixed',
      results: [
        { path: '/image.gif', allowed: false },
        { path: '/image.gif?size=large', allowed: true },
        { path: '/a', allowed: true },
        { path: '/abxb', allowed: false },
        { path: '/assets/a/public', allowed: true },
        { path: '/assets/a/public/extra', allowed: true },
      ],
    })
  })

  it('normalizes UTF-8 and unreserved escapes but preserves reserved %2F and query boundaries', () => {
    const groups = parseRobots(`User-agent: *
      Disallow: /caf%C3%A9
      Disallow: /b
      Disallow: /reserved/%2F
      Disallow: /query?x=1
    `)
    const result = evaluateRobots(groups, 'Crawler', [
      '/café',
      '/caf%C3%A9',
      '/%62',
      '/b',
      '/reserved/%2F',
      '/reserved//',
      '/query?x=1',
      '/query?x=2',
    ])
    expect(result?.results).toEqual([
      { path: '/café', allowed: false },
      { path: '/caf%C3%A9', allowed: false },
      { path: '/%62', allowed: false },
      { path: '/b', allowed: false },
      { path: '/reserved/%2F', allowed: false },
      { path: '/reserved//', allowed: true },
      { path: '/query?x=1', allowed: false },
      { path: '/query?x=2', allowed: true },
    ])
  })

  it('matches paths case-sensitively and requires an exact case-insensitive product token', () => {
    const groups = parseRobots('User-agent: GPTBot\nDisallow: /Case')
    expect(evaluateRobots(groups, 'GPTBot', ['/case', '/Case'])).toMatchObject({
      policy: 'mixed',
      results: [{ path: '/case', allowed: true }, { path: '/Case', allowed: false }],
    })
    expect(evaluateRobots(groups, 'OtherBot', ['/Case'])).toBeNull()
    expect(evaluateRobots(parseRobots('User-agent: bot\nDisallow: /private'), 'GPTBot', ['/private'])).toBeNull()
  })

  it('accepts legal empty and comment-only content while rejecting obvious HTML and binary bodies', () => {
    expect(isRobotsText('')).toBe(true)
    expect(isRobotsText('\uFEFF  \t\n# comment only\n')).toBe(true)
    expect(isRobotsText('User-agent: *\nDisallow: /')).toBe(true)
    expect(isRobotsText('<!doctype html><html><body>fallback</body></html>')).toBe(false)
    expect(isRobotsText('  <html><head></head></html>')).toBe(false)
    expect(isRobotsText('PK\u0003\u0004\u0014\u0000')).toBe(false)
  })

  it('ignores rules before the first user-agent but keeps empty rules as group boundaries', () => {
    const groups: RobotsGroup[] = parseRobots('Disallow: /before\nUser-agent: GPTBot\nDisallow:\nUser-agent: OtherBot\nDisallow: /other')
    expect(groups).toEqual([
      { agents: ['gptbot'], rules: [{ allow: false, path: '' }] },
      { agents: ['otherbot'], rules: [{ allow: false, path: '/other' }] },
    ])
    expect(evaluateRobots(groups, 'GPTBot', ['/before', '/other'])).toMatchObject({ policy: 'allowed' })
    expect(evaluateRobots(groups, 'OtherBot', ['/other'])).toMatchObject({ policy: 'restricted' })
  })

  it('evaluates all generic groups for the generic policy, including mixed agent declarations', () => {
    const groups = parseRobots(`
      User-agent: *
      Disallow: /private
      User-agent: ExampleBot
      Allow: /

      User-agent: *
      Allow: /private/public
    `)
    const result = evaluateRobotsWithRules(groups, '*', ['/private', '/private/public', '/public'])
    expect(result?.policy).toBe('mixed')
    expect(result?.results).toEqual([
      { path: '/private', allowed: false, matched_rule: { allow: false, path: '/private' } },
      { path: '/private/public', allowed: true, matched_rule: { allow: true, path: '/private/public' } },
      { path: '/public', allowed: true, matched_rule: null },
    ])
  })
})
