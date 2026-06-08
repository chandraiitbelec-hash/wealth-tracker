/**
 * GET /api/news
 *
 * Query params:
 *   symbols  — comma-separated NSE symbols from the user's portfolio
 *              e.g. ?symbols=RELIANCE,HDFCBANK,INFY
 *   category — economy | market | stocks | mf | all  (default: all)
 *   limit    — max articles per category (default: 20)
 *
 * Response:
 *   {
 *     portfolio: Article[]   — articles mentioning the user's holdings (highest relevance)
 *     economy:   Article[]   — macro/RBI/policy
 *     market:    Article[]   — indices/FII/sector
 *     stocks:    Article[]   — company news (not in portfolio)
 *     mf:        Article[]   — mutual fund news
 *     source:    "db" | "rss_fallback"
 *     fetchedAt: string
 *   }
 *
 * DB-first: reads from news_articles populated by Python pipeline.
 * If DB is empty (pipeline not yet run), falls back to fetching a
 * curated subset of feeds directly from the Next.js server.
 */

import { NextRequest, NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export const runtime = 'nodejs'

export interface Article {
  id?: number
  source: string
  category: string
  title: string
  summary: string | null
  url: string
  publishedAt: string
  taggedSymbols: string[]
  relevantHolding?: string   // set when article matches a portfolio symbol
}

// ── Curated fallback feeds (subset — fast to fetch synchronously) ─────────────

const FALLBACK_FEEDS = [
  // Market
  { url: 'https://www.moneycontrol.com/rss/MCtopnews.xml',                source: 'moneycontrol',   category: 'market'  },
  { url: 'https://www.livemint.com/rss/markets',                           source: 'livemint',       category: 'market'  },
  { url: 'https://www.business-standard.com/rss/markets-106.rss',         source: 'business_std',   category: 'market'  },
  // Economy
  { url: 'https://www.business-standard.com/rss/economy-policy-10601.rss', source: 'business_std',  category: 'economy' },
  { url: 'https://www.moneycontrol.com/rss/economy.xml',                  source: 'moneycontrol',   category: 'economy' },
  // Companies / Stocks
  { url: 'https://www.business-standard.com/rss/companies-101.rss',       source: 'business_std',   category: 'stocks'  },
  { url: 'https://www.moneycontrol.com/rss/results.xml',                  source: 'moneycontrol',   category: 'stocks'  },
  // Mutual funds (livemint money is the best live option right now)
  { url: 'https://www.livemint.com/rss/money',                            source: 'livemint',       category: 'mf'      },
]

const SOURCE_LABELS: Record<string, string> = {
  economic_times: 'Economic Times',
  moneycontrol:   'Moneycontrol',
  business_std:   'Business Standard',
  livemint:       'Livemint',
  mint:           'Mint',
  rbi:            'RBI',
  sebi:           'SEBI',
  bs_markets:     'Business Standard',
  et_stocks:      'Economic Times',
  mc_stocks:      'Moneycontrol',
  mc_mf:          'Moneycontrol',
  mint_mf:        'Mint',
}

function friendlySource(s: string): string {
  return SOURCE_LABELS[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── XML parser (used in fallback only) ───────────────────────────────────────

function parseRSSXml(xml: string, source: string, category: string): Article[] {
  const items: Article[] = []
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)

  for (const match of itemMatches) {
    const block = match[1]

    const title   = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1]
                 ?? block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim()
    const link    = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1]
                 ?? block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1] ?? '').trim()
    const desc    = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1]
                 ?? block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '').replace(/<[^>]+>/g, '').trim()
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? ''

    if (!title || !link) continue

    let publishedAt: string
    try { publishedAt = new Date(pubDate).toISOString() }
    catch { publishedAt = new Date().toISOString() }

    items.push({
      source:         friendlySource(source),
      category,
      title:          title.slice(0, 200),
      summary:        desc.slice(0, 400) || null,
      url:            link,
      publishedAt,
      taggedSymbols:  [],
    })
  }
  return items
}

async function fetchRSSFallback(portfolioSymbols: string[], companyNames: string[] = []): Promise<Article[]> {
  const results = await Promise.allSettled(
    FALLBACK_FEEDS.map(async ({ url, source, category }) => {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (WealthTracker RSS Reader)' },
        next: { revalidate: 900 },   // cache 15 min in Next.js fetch cache
      })
      if (!r.ok) return []
      const xml = await r.text()
      return parseRSSXml(xml, source, category)
    })
  )

  const allArticles: Article[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') allArticles.push(...r.value)
  }

  // Tag portfolio symbols in fallback mode.
  // Match against both NSE symbol (e.g. HDFCBANK) and company name (e.g. HDFC Bank),
  // but only store the NSE symbol in taggedSymbols so downstream filtering works.
  const upperSymbols = portfolioSymbols.map(s => s.toUpperCase())

  // Build lookup: normalised company-name keyword → NSE symbol
  // e.g. "HDFC BANK" → "HDFCBANK"
  const nameToSymbol: { keywords: string; symbol: string }[] = companyNames
    .map((name, i) => ({ keywords: name.toUpperCase().replace(/\s+LTD\.?$/i, '').trim(), symbol: portfolioSymbols[i] ?? '' }))
    .filter(x => x.symbol && x.keywords.length >= 4)

  for (const a of allArticles) {
    const titleUpper = (a.title + ' ' + (a.summary ?? '')).toUpperCase()

    // Direct symbol match
    const symbolMatches = upperSymbols.filter(s => s.length >= 3 && titleUpper.includes(s))

    // Company-name match
    const nameMatches = nameToSymbol
      .filter(({ keywords }) => titleUpper.includes(keywords))
      .map(({ symbol }) => symbol)

    const allMatches = [...new Set([...symbolMatches, ...nameMatches])]
    if (allMatches.length > 0) a.taggedSymbols = allMatches
  }

  return allArticles
}

// ── DB fetch ──────────────────────────────────────────────────────────────────

async function fetchFromDB(
  portfolioSymbols: string[],
  limit: number
): Promise<{ articles: Article[]; hasData: boolean }> {
  const client = await pool.connect()
  try {
    // Check if DB has recent data (within 2 hours).
    // Catch 42P01 ("relation does not exist") — table hasn't been created
    // yet because the pipeline hasn't run; fall back to RSS gracefully.
    let recentCount = 0
    try {
      const { rows: check } = await client.query(`
        SELECT COUNT(*) AS n FROM news_articles
        WHERE published_at > NOW() - INTERVAL '2 hours'
      `)
      recentCount = parseInt(check[0].n)
    } catch (err: unknown) {
      const pgErr = err as { code?: string }
      if (pgErr?.code === '42P01') {
        // Table doesn't exist — pipeline has never run
        return { articles: [], hasData: false }
      }
      throw err  // re-throw unexpected DB errors
    }
    if (recentCount === 0) {
      return { articles: [], hasData: false }
    }

    // Shape of a raw DB row from news_articles
    interface NewsRow {
      id: number
      source: string
      category: string
      title: string
      summary: string | null
      url: string
      published_at: Date | string
      tagged_symbols: string[] | null
    }

    // Portfolio-relevant articles first
    let portfolioRows: NewsRow[] = []
    if (portfolioSymbols.length > 0) {
      const { rows } = await client.query(`
        SELECT id, source, category, title, summary, url,
               published_at, tagged_symbols
        FROM news_articles
        WHERE tagged_symbols && $1::text[]
        ORDER BY published_at DESC
        LIMIT $2
      `, [portfolioSymbols, limit])
      portfolioRows = rows as NewsRow[]
    }

    // Category articles (exclude already-fetched portfolio articles)
    const excludeIds = portfolioRows.map(r => r.id)
    const { rows: catRows } = await client.query(`
      SELECT id, source, category, title, summary, url,
             published_at, tagged_symbols
      FROM news_articles
      WHERE ($1::int[] IS NULL OR id <> ALL($1::int[]))
      ORDER BY published_at DESC
      LIMIT $2
    `, [excludeIds.length > 0 ? excludeIds : null, limit * 4])

    const toArticle = (r: NewsRow): Article => ({
      id:            r.id,
      source:        friendlySource(r.source),
      category:      r.category,
      title:         r.title,
      summary:       r.summary,
      url:           r.url,
      publishedAt:   r.published_at instanceof Date
                       ? r.published_at.toISOString()
                       : String(r.published_at),
      taggedSymbols: r.tagged_symbols ?? [],
    })

    // Annotate portfolio articles with which holding triggered the match
    const portfolioArticles = portfolioRows.map(r => {
      const a = toArticle(r)
      const match = (r.tagged_symbols ?? []).find((s: string) =>
        portfolioSymbols.includes(s)
      )
      if (match) a.relevantHolding = match
      return a
    })

    return {
      articles: [...portfolioArticles, ...catRows.map(toArticle)],
      hasData: true,
    }
  } finally {
    client.release()
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const symbolsParam = searchParams.get('symbols') ?? ''
    const namesParam   = searchParams.get('names')   ?? ''
    const limitParam   = parseInt(searchParams.get('limit') ?? '20', 10)

    const portfolioSymbols = symbolsParam
      ? symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      : []
    const companyNames = namesParam
      ? namesParam.split(',').map(s => s.trim()).filter(Boolean)
      : []
    const limit = Math.min(50, Math.max(5, limitParam))

    // Try DB first
    const { articles: dbArticles, hasData } = await fetchFromDB(portfolioSymbols, limit)

    let allArticles: Article[]
    let source: 'db' | 'rss_fallback'

    if (hasData) {
      allArticles = dbArticles
      source = 'db'
    } else {
      // Pipeline hasn't run yet — fetch RSS directly
      allArticles = await fetchRSSFallback(portfolioSymbols, companyNames)
      source = 'rss_fallback'
    }

    // Split into zoom levels
    const portfolio = allArticles
      .filter(a => a.taggedSymbols.some(s => portfolioSymbols.includes(s)))
      .slice(0, limit)

    const portfolioIds = new Set(portfolio.map(a => a.url))

    const byCategory = (cat: string) =>
      allArticles
        .filter(a => a.category === cat && !portfolioIds.has(a.url))
        .slice(0, limit)

    return NextResponse.json({
      portfolio,
      economy: byCategory('economy'),
      market:  byCategory('market'),
      stocks:  byCategory('stocks'),
      mf:      byCategory('mf'),
      source,
      fetchedAt: new Date().toISOString(),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('News API error:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
