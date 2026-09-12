import { describe, expect, it } from 'vitest'
import { analyzeStructuredDataPage } from './technical-audit-structured.ts'

const page = (body: string) => `<!doctype html><html><head><title>示例</title></head><body>${body}</body></html>`
const url = 'https://audit.example/articles/example'

describe('structured-data format detection', () => {
  it('accepts a non-empty JSON-LD entity and an absolute-IRI property', async () => {
    const jsonLd = await analyzeStructuredDataPage({ html: page('<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing","name":"示例"}</script>'), pageUrl: url })
    expect(jsonLd).toMatchObject({ formats: ['JSON-LD'], valid: true, issues: [] })

    const absoluteIri = await analyzeStructuredDataPage({ html: page('<script type="application/ld+json">{"https://schema.org/name":"示例"}</script>'), pageUrl: url })
    expect(absoluteIri).toMatchObject({ formats: ['JSON-LD'], valid: true, issues: [] })
  })

  it('does not count ordinary JSON, empty containers, or context-only JSON-LD', async () => {
    for (const source of ['{"name":"示例"}', '{}', '[]', 'null', '{"@context":"https://schema.org"}', '{"@set":[]}', '{"@id":""}', '{"@language":"zh-CN"}', '{"@index":"item-1"}', '{"@language":"zh-CN","@index":"item-1"}']) {
      const result = await analyzeStructuredDataPage({ html: page(`<script type="application/ld+json">${source}</script>`), pageUrl: url })
      expect(result.formats, source).toEqual([])
      expect(result.issues, source).toEqual([])
    }
  })

  it('accepts MIME parameters around application/ld+json', async () => {
    const result = await analyzeStructuredDataPage({
      html: page('<script type=" application/ld+json ; charset=utf-8 ">{"@type":"Thing","name":"示例"}</script>'),
      pageUrl: url,
    })
    expect(result).toMatchObject({ formats: ['JSON-LD'], valid: true })
  })

  it('accepts a JSON-LD block with no @id and does not require Schema.org fields', async () => {
    const result = await analyzeStructuredDataPage({
      html: page('<script type="application/ld+json">{"@type":"Thing","name":"示例"}</script>'),
      pageUrl: url,
    })
    expect(result).toMatchObject({ formats: ['JSON-LD'], valid: true })
  })

  it('accepts Microdata itemtype-only scopes and nested scopes without ids', async () => {
    const typeOnly = await analyzeStructuredDataPage({ html: page('<div itemscope itemtype="https://schema.org/Thing"></div>'), pageUrl: url })
    expect(typeOnly).toMatchObject({ formats: ['Microdata'], valid: true })

    const nested = await analyzeStructuredDataPage({ html: page('<div itemscope><div itemprop="child" itemscope><span itemprop="name">子对象</span></div></div>'), pageUrl: url })
    expect(nested).toMatchObject({ formats: ['Microdata'], valid: true })
  })

  it('supports Microdata itemref without treating the reference as a missing marker', async () => {
    const result = await analyzeStructuredDataPage({
      html: page('<div itemscope itemtype="https://schema.org/Thing" itemref="extra:part[0]"></div><div id="extra:part[0]"><span itemprop="name">示例</span></div>'),
      pageUrl: url,
    })
    expect(result).toMatchObject({ formats: ['Microdata'], valid: true })
  })

  it('accepts RDFa vocab/typeof and the valid vocab+rel form', async () => {
    const typed = await analyzeStructuredDataPage({ html: page('<div vocab="https://schema.org/" typeof="Thing"><span property="name">示例</span></div>'), pageUrl: url })
    expect(typed).toMatchObject({ formats: ['RDFa'], valid: true })

    const relation = await analyzeStructuredDataPage({ html: page('<div vocab="https://schema.org/"><a rel="url" href="https://audit.example/">网址</a></div>'), pageUrl: url })
    expect(relation).toMatchObject({ formats: ['RDFa'], valid: true })
  })

  it('does not count role/ordinary rel or vocab-only helper triples as RDFa', async () => {
    for (const body of [
      '<main role="main"><a rel="canonical" href="https://audit.example/">网址</a></main>',
      '<div vocab="https://schema.org/"><p>只有词表声明</p></div>',
      '<div prefix="schema: https://schema.org/"><div role="main">正文</div></div>',
    ]) {
      const result = await analyzeStructuredDataPage({ html: page(body), pageUrl: url })
      expect(result.formats, body).toEqual([])
    }
  })

  it('preserves HTML RDFa defaults for base tags and xmlns CURIE relations', async () => {
    const base = await analyzeStructuredDataPage({
      html: '<!doctype html><html><head><base href="https://audit.example/base/"></head><body><a rel="https://schema.org/url" href="target">网址</a></body></html>',
      pageUrl: url,
    })
    expect(base).toMatchObject({ formats: ['RDFa'], valid: true })

    const namespace = await analyzeStructuredDataPage({
      html: page('<div xmlns:ex="https://example.com/"><a rel="ex:related" href="/target">关联</a></div>'),
      pageUrl: url,
    })
    expect(namespace).toMatchObject({ formats: ['RDFa'], valid: true })
  })

  it('does not let an invalid JSON-LD block hide behind a valid Microdata marker', async () => {
    const result = await analyzeStructuredDataPage({
      html: page('<script type="application/ld+json">{invalid</script><div itemscope itemtype="https://schema.org/Thing"></div>'),
      pageUrl: url,
    })
    expect(result.formats).toEqual(['Microdata'])
    expect(result.valid).toBe(false)
    expect(result.issues).toEqual([{ format: 'JSON-LD', reason: 'invalid_syntax', location: 'script-1' }])
  })

  it('does not treat empty legal containers as errors when another marker is valid', async () => {
    const result = await analyzeStructuredDataPage({
      html: page('<div itemscope></div><script type="application/ld+json">{"@type":"Thing"}</script><div vocab="https://schema.org/"></div>'),
      pageUrl: url,
    })
    expect(result).toMatchObject({ formats: ['JSON-LD'], valid: true, issues: [] })
  })

  it('uses fixed evidence ordinals rather than copying page element ids', async () => {
    const result = await analyzeStructuredDataPage({
      html: page('<div id="customer-secret-id" itemscope itemtype="https://schema.org/Thing"></div>'),
      pageUrl: url,
    })
    expect(result.evidence).toEqual([{ format: 'Microdata', location: 'node-1', count: 1 }])
    expect(JSON.stringify(result)).not.toContain('customer-secret-id')
  })
})
