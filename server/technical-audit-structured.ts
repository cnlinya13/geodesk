import { parse, type HTMLElement } from 'node-html-parser'
import { MicrodataRdfParser } from 'microdata-rdf-streaming-parser'
import { RdfaParser, RDFA_FEATURES } from 'rdfa-streaming-parser'

export type StructuredDataFormat = 'JSON-LD' | 'Microdata' | 'RDFa'

export type StructuredDataIssue = {
  format: StructuredDataFormat
  reason: 'invalid_syntax' | 'empty_declaration' | 'parser_error'
  location: string
}

export type StructuredDataPageResult = {
  formats: StructuredDataFormat[]
  valid: boolean
  issues: StructuredDataIssue[]
  evidence: Array<{
    format: StructuredDataFormat
    location: string
    count: number
  }>
}

type RdfQuad = { subject?: unknown; predicate?: unknown; object?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasJsonLdKeyword(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasJsonLdKeyword)
  if (!isRecord(value)) return false
  return Object.keys(value).some((key) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(key)
    || key === '@context'
    || key === '@id'
    || key === '@type'
    || key === '@graph'
    || key === '@value'
    || key === '@language'
    || key === '@list'
    || key === '@set'
    || key === '@reverse'
    || key === '@index'
    || key === '@included'
    || key === '@nest')
}

function hasNonEmptyJsonLdValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.some(hasNonEmptyJsonLdValue)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, entry]) => key !== '@context' && key !== '@version' && hasNonEmptyJsonLdValue(entry))
}

function hasJsonLdData(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasJsonLdData)
  if (!isRecord(value)) return false
  for (const [key, entry] of Object.entries(value)) {
    if (key === '@context' || key === '@version') continue
    if (key === '@graph' || key === '@included' || key === '@reverse' || key === '@nest') {
      if (hasJsonLdData(entry)) return true
      continue
    }
    if (key === '@set' || key === '@list') {
      if (Array.isArray(entry) && entry.length > 0 && entry.some(hasJsonLdData)) return true
      continue
    }
    // @language and @index are attached metadata.  They only become part of
    // actual JSON-LD data when paired with a data-bearing term such as @value,
    // @id, @type, @graph, or a normal property.
    if (key === '@language' || key === '@index') continue
    if (key === '@id' || key === '@type' || key === '@value') {
      if (hasNonEmptyJsonLdValue(entry)) return true
      continue
    }
    if (hasNonEmptyJsonLdValue(entry)) return true
  }
  return false
}

function hasValidJsonLdDeclaration(value: unknown): boolean {
  return hasJsonLdKeyword(value) && hasJsonLdData(value)
}

function nodeLocation(node: HTMLElement, ordinal: number): string {
  void node
  return `node-${ordinal + 1}`
}

function hasRdfaDeclaration(node: HTMLElement): boolean {
  // Namespace declarations are not represented by the ordinary RDFa
  // attribute selector below, but an xmlns/prefix mapping can make a
  // rel/rev CURIE on a descendant a valid RDFa declaration.
  if (Object.keys(node.attributes).some((name) => {
    const normalized = name.toLowerCase()
    return normalized === 'xmlns' || normalized.startsWith('xmlns:')
  })) return true

  // rel/rev alone are ordinary HTML link semantics and role can create
  // RDFa-parser helper triples.  Require an RDFa-specific declaration before
  // treating emitted quads as an actual RDFa marker.
  if (['property', 'typeof', 'about', 'resource', 'datatype', 'prefix', 'inlist', 'vocab'].some((name) => node.hasAttribute(name))) return true
  return ['rel', 'rev'].some((name) => (node.getAttribute(name) ?? '').split(/\s+/).some((value) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)))
}

async function parseRdfQuads(
  parser: any,
  html: string,
): Promise<{ count: number; error: Error | null }> {
  return new Promise((resolve) => {
    let count = 0
    let settled = false
    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      resolve({ count, error })
    }
    parser.on('data', (quad: RdfQuad) => {
      // A parser data event is enough to prove that the declaration produced
      // RDF data; terms are deliberately not copied into audit evidence.
      const predicate = quad && typeof quad.predicate === 'object' && quad.predicate !== null
        ? (quad.predicate as { value?: unknown }).value
        : null
      if (quad && typeof quad === 'object' && predicate !== 'http://www.w3.org/ns/rdfa#usesVocabulary') count += 1
    })
    parser.on('error', (error: unknown) => finish(error instanceof Error ? error : new Error('structured_parser_error')))
    parser.on('end', () => finish(null))
    try {
      parser.end(html)
    } catch (error) {
      finish(error instanceof Error ? error : new Error('structured_parser_error'))
    }
  })
}

export async function analyzeStructuredDataPage(input: {
  html: string
  pageUrl: string
  document?: ReturnType<typeof parse> | null
}): Promise<StructuredDataPageResult> {
  const document = input.document ?? parse(input.html)
  const formats = new Set<StructuredDataFormat>()
  const issues: StructuredDataIssue[] = []
  const evidence: StructuredDataPageResult['evidence'] = []

  const jsonLdScripts = document.querySelectorAll('script').filter((script) => (script.getAttribute('type') ?? '').split(';', 1)[0]?.trim().toLowerCase() === 'application/ld+json')
  let jsonLdValidCount = 0
  const jsonLdValidLocations: string[] = []
  jsonLdScripts.forEach((script, index) => {
    const location = `script-${index + 1}`
    const raw = script.textContent.trim()
    if (!raw) {
      issues.push({ format: 'JSON-LD', reason: 'empty_declaration', location })
      return
    }
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      issues.push({ format: 'JSON-LD', reason: 'invalid_syntax', location })
      return
    }
    if (!hasValidJsonLdDeclaration(value)) {
      // application/ld+json containing ordinary JSON or an empty container
      // is not evidence of a usable structured-data marker.
      return
    }
    jsonLdValidCount += 1
    jsonLdValidLocations.push(location)
  })
  if (jsonLdValidCount > 0) {
    formats.add('JSON-LD')
    for (const location of jsonLdValidLocations) evidence.push({ format: 'JSON-LD', location, count: 1 })
  }

  const microdataScopes = document.querySelectorAll('[itemscope]')
  let microdata = { count: 0, error: null as Error | null }
  try {
    microdata = await parseRdfQuads(new MicrodataRdfParser({ baseIRI: input.pageUrl }), input.html)
  } catch {
    microdata = { count: 0, error: new Error('structured_parser_error') }
  }
  if (microdata.error) {
    issues.push({ format: 'Microdata', reason: 'parser_error', location: 'document' })
  } else if (microdata.count > 0 && microdataScopes.length > 0) {
    formats.add('Microdata')
    evidence.push({ format: 'Microdata', location: nodeLocation(microdataScopes[0], 0), count: microdataScopes.length })
  }

  // Iterate over elements once instead of relying only on an attribute
  // selector: xmlns declarations are valid RDFa prefix mappings but are not
  // reliably matched by the simplified selector implementation.
  const allElements = document.querySelectorAll('*')
  const rdfaNodes = allElements.filter(hasRdfaDeclaration)
  let rdfa = { count: 0, error: null as Error | null }
  try {
    // Start from the HTML profile instead of replacing it with a partial
    // feature object.  In particular, preserve base-tag handling and xmlns
    // prefix mappings while disabling role-derived helper triples, which are
    // not RDFa content for this audit.
    rdfa = await parseRdfQuads(new RdfaParser({
      baseIRI: input.pageUrl,
      contentType: 'text/html',
      features: { ...RDFA_FEATURES.html, roleAttribute: false },
    }), input.html)
  } catch {
    rdfa = { count: 0, error: new Error('structured_parser_error') }
  }
  if (rdfa.error) {
    issues.push({ format: 'RDFa', reason: 'parser_error', location: 'document' })
  } else if (rdfa.count > 0 && rdfaNodes.length > 0) {
    formats.add('RDFa')
    evidence.push({ format: 'RDFa', location: nodeLocation(rdfaNodes[0], allElements.indexOf(rdfaNodes[0])), count: rdfaNodes.length })
  }

  // Keep the page URL as an input for callers that want to pair this result
  // with a safe URL; never include it, HTML, or parser terms in the result.
  void input.pageUrl
  return { formats: [...formats], valid: formats.size > 0 && issues.length === 0, issues, evidence }
}

export function structuredDataIssueMessage(issue: StructuredDataIssue): string {
  if (issue.reason === 'invalid_syntax') return `${issue.format}语法解析失败`
  if (issue.reason === 'parser_error') return `${issue.format}基础解析失败`
  return `${issue.format}未形成有效的数据声明`
}
