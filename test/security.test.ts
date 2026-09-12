import test from 'node:test'
import assert from 'node:assert/strict'

process.env.ABS_URL = 'http://audiobookshelf.internal:3000'
process.env.USE_PROXY = 'true'
process.env.OPDS_USERS = ''

const { buildUpstreamURL } = await import('../src/helpers/api.js')
const { matchesFreeText, matchesNameCategory, normalizeSearchTerm } = await import('../src/helpers/search.js')
const { buildCardEntries, buildOPDSXMLSkeleton } = await import('../src/helpers/abs.js')
const { sanitizeFilenameBase } = await import('../src/helpers/download.js')

const item = {
    id: 'i1',
    title: 'a+b (Deluxe)',
    subtitle: '',
    description: 'A story about C++ and other things',
    publisher: 'Acme',
    isbn: '123',
    publishedYear: '2020',
    language: 'en',
    authors: [{ name: 'Tom & Jerry' }],
    narrators: [{ name: 'Reader One' }],
    genres: ['Sci-Fi'],
    tags: ['favourite'],
    format: 'epub',
    series: ['Best Of'],
    addedAt: '2020-01-01'
}

test('proxy target cannot escape the configured Audiobookshelf origin', () => {
    // A protocol-relative path such as "//evil.example" would otherwise replace
    // the base host entirely. Hostile input is neutralised onto the configured
    // origin (or rejected); it must never resolve to another host.
    const hostile = [
        '//evil.example/steal',
        '///evil.example/steal',
        '\\\\evil.example/steal',
        '/\\evil.example/steal',
        'https://evil.example/steal',
        '//user:pw@evil.example/steal',
        '//evil.example:8080/steal'
    ]

    for (const path of hostile) {
        const target = buildUpstreamURL(path)
        assert.notEqual(target?.origin, 'https://evil.example', `${path} escaped the configured origin`)
        assert.ok(
            target === null || target.origin === 'http://audiobookshelf.internal:3000',
            `${path} resolved to ${target?.origin}`
        )
    }
})

test('proxy target resolves normal paths against the Audiobookshelf origin', () => {
    assert.equal(
        buildUpstreamURL('/api/items/abc/cover?token=x')?.toString(),
        'http://audiobookshelf.internal:3000/api/items/abc/cover?token=x'
    )
    // An encoded slash stays encoded and stays on-origin.
    assert.equal(buildUpstreamURL('/%2F%2Fevil.example')?.origin, 'http://audiobookshelf.internal:3000')
})

test('search terms are matched literally, never compiled as a regular expression', () => {
    const plus = normalizeSearchTerm('a+b')!
    assert.equal(matchesFreeText(item as any, plus), true, 'literal "a+b" should match the title')

    // As a regex, "a." would match "a+"; as a literal it must not.
    assert.equal(matchesFreeText(item as any, normalizeSearchTerm('a.b')!), false)
    assert.equal(matchesFreeText(item as any, normalizeSearchTerm('c++')!), true)
})

test('malformed and catastrophic patterns are inert rather than fatal', () => {
    for (const term of ['[', '(', '*', '(a+)+$', '([a-za-z ]+)+!']) {
        const started = Date.now()
        assert.doesNotThrow(() => matchesFreeText(item as any, normalizeSearchTerm(term)!))
        assert.ok(Date.now() - started < 250, `"${term}" should not stall the matcher`)
    }
})

test('name-category filters match the right field', () => {
    assert.equal(matchesNameCategory(item as any, 'authors', 'tom & jerry'), true)
    assert.equal(matchesNameCategory(item as any, 'narrators', 'tom & jerry'), false)
    assert.equal(matchesNameCategory(item as any, 'genres', 'favourite'), true, 'tags count as genres')
    assert.equal(matchesNameCategory(item as any, 'series', 'best of'), true)
})

test('card links encode names that contain query-string syntax', () => {
    const xml = buildCardEntries(['Tom & Jerry', 'AC/DC', 'Alice #1'], 'authors', { name: 'u', apiKey: 'k' }, 'L1')
    // Attribute values are XML-escaped on the way out; decode before parsing.
    const hrefs = xml.map((entry) => (/href="([^"]+)"/.exec(entry.end())?.[1] ?? '').replace(/&amp;/g, '&'))

    for (const href of hrefs) {
        const parsed = new URL(href, 'http://x.invalid')
        // Exactly the two intended parameters, with the name surviving intact.
        assert.deepEqual([...parsed.searchParams.keys()].sort(), ['name', 'type'])
        assert.equal(parsed.searchParams.get('type'), 'authors')
    }
    assert.equal(new URL(hrefs[0], 'http://x.invalid').searchParams.get('name'), 'Tom & Jerry')
    assert.equal(new URL(hrefs[1], 'http://x.invalid').searchParams.get('name'), 'AC/DC')
    assert.equal(new URL(hrefs[2], 'http://x.invalid').searchParams.get('name'), 'Alice #1')
})

test('pagination links keep sibling query parameters regardless of order', () => {
    const feed = buildOPDSXMLSkeleton(
        'id',
        'title',
        [],
        { id: 'L1', name: 'Books', icon: 'book' },
        { name: 'u', apiKey: 'k' },
        { originalUrl: '/opds/libraries/L1?page=2&sort=recent', query: { page: '2' } } as any,
        false,
        100
    )

    const next = /rel="next"[^>]*href="([^"]+)"/.exec(feed)?.[1] ?? ''
    const decoded = next.replace(/&amp;/g, '&')
    const parsed = new URL(decoded, 'http://x.invalid')

    assert.equal(parsed.pathname, '/opds/libraries/L1')
    assert.equal(parsed.searchParams.get('page'), '3')
    assert.equal(parsed.searchParams.get('sort'), 'recent')
})

test('download filenames cannot traverse or inject path separators', () => {
    assert.equal(sanitizeFilenameBase('../../etc/passwd'), '.._.._etc_passwd')
    assert.equal(sanitizeFilenameBase(''), 'book')
    assert.ok(!sanitizeFilenameBase('a/b\\c:d').includes('/'))
})
