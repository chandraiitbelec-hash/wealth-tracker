/**
 * POST /api/exits
 *
 * Accepts a stock order history file (multipart form), parses SELL transactions
 * from the last 12 months, enriches each with today's price from our DB,
 * and returns an exit analysis payload.
 *
 * Body: FormData with field "orders" (XLSX/CSV file)
 */

import { NextRequest, NextResponse } from 'next/server'
import { pool } from '@/lib/db'
import { parseStockOrders, recentSells } from '@/lib/parsers/stock-orders'

export const runtime = 'nodejs'

export interface ExitRecord {
  symbol: string
  isin: string
  stockName: string
  sells: { date: string; quantity: number; price: number; totalValue: number }[]
  totalSoldQty: number
  avgExitPrice: number
  totalExitValue: number
  earliestSell: string
  latestSell: string
  currentPrice: number | null
  priceDate: string | null
  companyName: string | null
  sector: string | null
  currentValueIfHeld: number | null
  gainLossSinceExit: number | null
  gainLossPct: number | null
  verdict: 'good_exit' | 'missed_gains' | 'unknown'
}

export interface ExitAnalysis {
  totalExits: number
  totalRealised: number
  totalMissedGains: number
  totalSavedLosses: number
  exits: ExitRecord[]
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('orders') as File | null
    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })

    const buffer  = await file.arrayBuffer()
    const allOrders = parseStockOrders(buffer)
    const sells   = recentSells(allOrders, 12)

    if (sells.length === 0) {
      return NextResponse.json({
        totalExits: 0, totalRealised: 0, totalMissedGains: 0, totalSavedLosses: 0, exits: [],
      } as ExitAnalysis)
    }

    // Aggregate by ISIN (or symbol as fallback)
    const byKey: Record<string, typeof sells> = {}
    for (const s of sells) {
      const key = s.isin || s.symbol
      if (!byKey[key]) byKey[key] = []
      byKey[key].push(s)
    }

    const isins   = [...new Set(sells.map(s => s.isin).filter(Boolean))]
    const symbols  = [...new Set(sells.map(s => s.symbol).filter(Boolean))]

    // Fetch current prices using the same query pattern as /api/enrich
    const priceQuery = `
      SELECT
        em.isin,
        em.symbol,
        em.company_name,
        em.sector,
        dp.close_price AS current_price,
        dp.price_date
      FROM equity_master em
      LEFT JOIN LATERAL (
        SELECT close_price, price_date
        FROM daily_prices
        WHERE security_id = em.security_id
        ORDER BY price_date DESC
        LIMIT 1
      ) dp ON TRUE
    `

    const client = await pool.connect()
    let priceRows: any[] = []
    try {
      if (isins.length > 0) {
        const { rows } = await client.query(priceQuery + ' WHERE em.isin = ANY($1)', [isins])
        priceRows.push(...rows)
      }
      const remainingSymbols = symbols.filter(
        sym => !priceRows.some(r => r.symbol === sym)
      )
      if (remainingSymbols.length > 0) {
        const { rows } = await client.query(priceQuery + ' WHERE em.symbol = ANY($1)', [remainingSymbols])
        priceRows.push(...rows)
      }
    } finally {
      client.release()
    }

    const byIsin:   Record<string, any> = {}
    const bySymbol: Record<string, any> = {}
    for (const r of priceRows) {
      if (r.isin)   byIsin[r.isin]     = r
      if (r.symbol) bySymbol[r.symbol]  = r
    }

    const exits: ExitRecord[] = []

    for (const [, trades] of Object.entries(byKey)) {
      const first = trades[0]
      const priceRow = byIsin[first.isin] ?? bySymbol[first.symbol] ?? null

      const totalSoldQty   = trades.reduce((s, t) => s + t.quantity,   0)
      const totalExitValue = trades.reduce((s, t) => s + t.totalValue, 0)
      const avgExitPrice   = totalExitValue / totalSoldQty

      const currentPrice       = priceRow?.current_price ? parseFloat(priceRow.current_price) : null
      const currentValueIfHeld = currentPrice !== null ? currentPrice * totalSoldQty : null
      const gainLossSinceExit  = currentValueIfHeld !== null ? currentValueIfHeld - totalExitValue : null
      const gainLossPct        = gainLossSinceExit  !== null && totalExitValue > 0
        ? (gainLossSinceExit / totalExitValue) * 100 : null

      const dates = trades.map(t => t.date).sort()

      exits.push({
        symbol:      first.symbol,
        isin:        first.isin,
        stockName:   priceRow?.company_name ?? first.stockName,
        sells:       trades.map(t => ({ date: t.date, quantity: t.quantity, price: t.price, totalValue: t.totalValue })),
        totalSoldQty,
        avgExitPrice,
        totalExitValue,
        earliestSell: dates[0],
        latestSell:   dates[dates.length - 1],
        currentPrice,
        priceDate:   priceRow?.price_date ?? null,
        companyName: priceRow?.company_name ?? null,
        sector:      priceRow?.sector ?? null,
        currentValueIfHeld,
        gainLossSinceExit,
        gainLossPct,
        verdict: gainLossSinceExit === null ? 'unknown'
          : gainLossSinceExit > 0 ? 'missed_gains'
          : 'good_exit',
      })
    }

    // Sort biggest impact first
    exits.sort((a, b) => Math.abs(b.gainLossSinceExit ?? 0) - Math.abs(a.gainLossSinceExit ?? 0))

    const totalMissedGains = exits
      .filter(e => e.verdict === 'missed_gains')
      .reduce((s, e) => s + (e.gainLossSinceExit ?? 0), 0)
    const totalSavedLosses = exits
      .filter(e => e.verdict === 'good_exit')
      .reduce((s, e) => s + Math.abs(e.gainLossSinceExit ?? 0), 0)

    return NextResponse.json({
      totalExits:    exits.length,
      totalRealised: exits.reduce((s, e) => s + e.totalExitValue, 0),
      totalMissedGains,
      totalSavedLosses,
      exits,
    } as ExitAnalysis)

  } catch (err: any) {
    console.error('[/api/exits]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
