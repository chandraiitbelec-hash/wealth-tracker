import { NextRequest, NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * POST /api/enrich
 *
 * Body: { stockIsins: string[], mfSchemeNames: string[] }
 *
 * Returns enriched data for stocks and MFs from our Supabase DB:
 * - Stocks: company name, sector, industry, our latest closing price
 * - MFs:    AMC, category, plan, option, our latest NAV
 */
export async function POST(req: NextRequest) {
  try {
    const { stockIsins = [], stockSymbols = [], mfSchemeNames = [] } = await req.json()

    const client = await pool.connect()
    try {
      // ── Enrich stocks by ISIN (Groww) or symbol (Zerodha) ──────────────
      let stockEnrichment: Record<string, any> = {}

      const stockQuery = `
        SELECT
          em.isin,
          em.symbol,
          em.company_name,
          em.sector,
          em.industry,
          em.face_value,
          em.listing_date,
          em.market_cap_category,
          dp.close_price   AS our_price,
          dp.price_date    AS price_date
        FROM equity_master em
        JOIN security_master sm ON sm.id = em.security_id
        LEFT JOIN LATERAL (
          SELECT close_price, price_date
          FROM daily_prices
          WHERE security_id = em.security_id
          ORDER BY price_date DESC
          LIMIT 1
        ) dp ON TRUE
      `

      // ISIN-based (Groww)
      if (stockIsins.filter(Boolean).length > 0) {
        const { rows } = await client.query(
          stockQuery + ' WHERE em.isin = ANY($1)',
          [stockIsins.filter(Boolean)]
        )
        for (const r of rows) {
          if (r.isin) stockEnrichment[r.isin] = r
        }
      }

      // Symbol-based (Zerodha) — for stocks with no ISIN
      if (stockSymbols.filter(Boolean).length > 0) {
        const { rows } = await client.query(
          stockQuery + ' WHERE em.symbol = ANY($1)',
          [stockSymbols.filter(Boolean)]
        )
        for (const r of rows) {
          // Key by symbol so portfolio.ts can look up by symbol
          stockEnrichment[r.symbol] = r
        }
      }

      // ── Enrich MFs by scheme name (fuzzy match) ──────────────────────
      let mfEnrichment: Record<string, any> = {}
      if (mfSchemeNames.length > 0) {
        // Exact match first, then falls back to ILIKE for partial matches
        const { rows } = await client.query(
          `
          SELECT
            mfm.scheme_name,
            mfm.amc_name,
            mfm.scheme_category,
            mfm.scheme_type,
            mfm.plan,
            mfm.option,
            mfm.isin_growth,
            mfm.isin_div_payout,
            mfm.scheme_code,
            dp.close_price   AS our_nav,
            dp.price_date    AS nav_date
          FROM mutual_fund_master mfm
          JOIN security_master sm ON sm.id = mfm.security_id
          LEFT JOIN LATERAL (
            SELECT close_price, price_date
            FROM daily_prices
            WHERE security_id = mfm.security_id
            ORDER BY price_date DESC
            LIMIT 1
          ) dp ON TRUE
          WHERE mfm.scheme_name = ANY($1)
          `,
          [mfSchemeNames]
        )

        // Map by exact scheme name
        for (const row of rows) {
          mfEnrichment[row.scheme_name] = row
        }

        // For unmatched names, try a fuzzy search
        const unmatched = mfSchemeNames.filter((n: string) => !mfEnrichment[n])
        if (unmatched.length > 0) {
          for (const name of unmatched) {
            const tokens = name.replace(/[^a-zA-Z0-9 ]/g, ' ').split(' ').filter(Boolean)

            // Always include the first token (AMC brand like DSP, Quant, Mirae)
            // + up to 3 more significant words (length > 3)
            const firstToken = tokens[0] ?? ''
            const rest = tokens.slice(1).filter((w: string) => w.length > 3).slice(0, 3)
            const words = [firstToken, ...rest].filter(Boolean)

            if (words.length === 0) continue

            const pattern = `%${words.join('%')}%`
            const { rows: fuzzy } = await client.query(
              `
              SELECT
                mfm.scheme_name,
                mfm.amc_name,
                mfm.scheme_category,
                mfm.scheme_type,
                mfm.plan,
                mfm.option,
                mfm.isin_growth,
                mfm.scheme_code,
                dp.close_price AS our_nav,
                dp.price_date  AS nav_date
              FROM mutual_fund_master mfm
              JOIN security_master sm ON sm.id = mfm.security_id
              LEFT JOIN LATERAL (
                SELECT close_price, price_date
                FROM daily_prices
                WHERE security_id = mfm.security_id
                ORDER BY price_date DESC
                LIMIT 1
              ) dp ON TRUE
              WHERE mfm.scheme_name ILIKE $1
              LIMIT 1
              `,
              [pattern]
            )
            if (fuzzy.length > 0) {
              mfEnrichment[name] = { ...fuzzy[0], matched_as: fuzzy[0].scheme_name }
            }
          }
        }
      }

      return NextResponse.json({ stockEnrichment, mfEnrichment })
    } finally {
      client.release()
    }
  } catch (err: any) {
    console.error('Enrich error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
