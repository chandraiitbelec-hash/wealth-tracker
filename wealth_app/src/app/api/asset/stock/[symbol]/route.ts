/**
 * GET /api/asset/stock/[symbol]
 *
 * Path params:
 *   symbol — NSE equity symbol (e.g. RELIANCE, HDFCBANK)
 *
 * Response:
 *   {
 *     meta:         { symbol, companyName, isin, sector, industry,
 *                     faceValue, listingDate, marketCapCategory, series }
 *     currentPrice: number | null         — live price or latest EOD close
 *     change:       number | null         — price change vs previous close
 *     changePct:    number | null         — % change vs previous close
 *     isLive:       boolean               — true if intraday feed is active
 *     priceHistory: { date: string; close: number }[]   — 2-year EOD series
 *     sentiment:    SentimentIndicator | null            — blended signal (null if not yet computed)
 *   }
 *
 * Returns 404 if the symbol is not in equity_master.
 */

import { NextRequest, NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { symbol: rawSymbol } = await params
  const symbol = rawSymbol.toUpperCase()
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

    const priceHistory = prices.map((r: { price_date: Date | string; close_price: string }) => ({
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

    // Sentiment indicators (best-effort — null if not yet computed)
    const { rows: sentRows } = await client.query(`
      SELECT
        blended_score,
        delivery_score, disclosure_score,
        institutional_score, derivatives_score,
        delivery_pct_5d, delivery_pct_20d, delivery_trend,
        mf_shares_change_pct,
        pcr, iv_skew,
        latest_disclosure_subject, latest_disclosure_score,
        signal, signal_reason,
        updated_at
      FROM stock_sentiment_indicators
      WHERE symbol = $1
      LIMIT 1
    `, [symbol])

    const sentiment = sentRows[0] ? {
      blendedScore:        parseFloat(sentRows[0].blended_score),
      subScores: {
        delivery:     sentRows[0].delivery_score,
        disclosure:   sentRows[0].disclosure_score,
        institutional:sentRows[0].institutional_score,
        derivatives:  sentRows[0].derivatives_score,
      },
      deliveryPct5d:       sentRows[0].delivery_pct_5d   ? parseFloat(sentRows[0].delivery_pct_5d)  : null,
      deliveryPct20d:      sentRows[0].delivery_pct_20d  ? parseFloat(sentRows[0].delivery_pct_20d) : null,
      deliveryTrend:       sentRows[0].delivery_trend,
      mfSharesChangePct:   sentRows[0].mf_shares_change_pct ? parseFloat(sentRows[0].mf_shares_change_pct) : null,
      pcr:                 sentRows[0].pcr      ? parseFloat(sentRows[0].pcr)      : null,
      ivSkew:              sentRows[0].iv_skew  ? parseFloat(sentRows[0].iv_skew)  : null,
      latestDisclosure:    sentRows[0].latest_disclosure_subject ?? null,
      latestDisclosureScore: sentRows[0].latest_disclosure_score ?? null,
      signal:              sentRows[0].signal,
      signalReason:        sentRows[0].signal_reason,
      updatedAt:           sentRows[0].updated_at,
    } : null

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
      sentiment,
    })
  } finally {
    client.release()
  }
}
