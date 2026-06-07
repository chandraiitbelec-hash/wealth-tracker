import { NextRequest, NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } }
) {
  const symbol = params.symbol.toUpperCase()
  const client = await pool.connect()
  try {
    // Company fundamentals
    const { rows: info } = await client.query(`
      SELECT
        em.symbol, em.company_name, em.isin, em.sector, em.industry,
        em.face_value, em.listing_date, em.market_cap_category, em.series,
        sm.id AS security_id
      FROM equity_master em
      JOIN security_master sm ON sm.id = em.security_id
      WHERE em.symbol = $1
      LIMIT 1
    `, [symbol])

    if (info.length === 0) {
      return NextResponse.json({ error: 'Symbol not found' }, { status: 404 })
    }
    const meta = info[0]

    // 2 years of daily close prices
    const { rows: prices } = await client.query(`
      SELECT price_date, close_price
      FROM daily_prices
      WHERE security_id = $1
        AND price_date >= CURRENT_DATE - INTERVAL '2 years'
      ORDER BY price_date ASC
    `, [meta.security_id])

    // Latest intraday price if available
    const { rows: live } = await client.query(`
      SELECT last_price, last_updated
      FROM intraday_live_feed
      WHERE security_id = $1
    `, [meta.security_id])

    const priceHistory = prices.map((r: any) => ({
      date:  r.price_date instanceof Date
        ? r.price_date.toISOString().split('T')[0]
        : String(r.price_date).split('T')[0],
      close: parseFloat(r.close_price),
    }))

    const latestClose = priceHistory.at(-1)?.close ?? null
    const prevClose   = priceHistory.at(-2)?.close ?? null
    const livePrice   = live[0]?.last_price ? parseFloat(live[0].last_price) : null
    const currentPrice = livePrice ?? latestClose
    const change      = currentPrice !== null && prevClose !== null ? currentPrice - prevClose : null
    const changePct   = change !== null && prevClose ? (change / prevClose) * 100 : null

    return NextResponse.json({
      meta: {
        symbol:            meta.symbol,
        companyName:       meta.company_name,
        isin:              meta.isin,
        sector:            meta.sector,
        industry:          meta.industry,
        faceValue:         meta.face_value ? parseFloat(meta.face_value) : null,
        listingDate:       meta.listing_date,
        marketCapCategory: meta.market_cap_category,
        series:            meta.series,
      },
      currentPrice,
      change,
      changePct,
      isLive: livePrice !== null,
      priceHistory,
    })
  } finally {
    client.release()
  }
}
