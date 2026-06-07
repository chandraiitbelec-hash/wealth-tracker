import { NextRequest, NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export const runtime = 'nodejs'

/** Compute CAGR between two NAV values over N days */
function cagr(startNav: number, endNav: number, days: number): number {
  if (startNav <= 0 || days <= 0) return 0
  return (Math.pow(endNav / startNav, 365 / days) - 1) * 100
}

/** Simple point-to-point return % */
function pointReturn(startNav: number, endNav: number): number {
  if (startNav <= 0) return 0
  return ((endNav - startNav) / startNav) * 100
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { schemeCode: string } }
) {
  const schemeCode = params.schemeCode
  const client = await pool.connect()
  try {
    // Fund info
    const { rows: info } = await client.query(`
      SELECT
        mfm.scheme_code, mfm.scheme_name, mfm.amc_name,
        mfm.scheme_category, mfm.scheme_type, mfm.plan, mfm.option,
        mfm.isin_growth, mfm.benchmark,
        sm.id AS security_id
      FROM mutual_fund_master mfm
      JOIN security_master sm ON sm.id = mfm.security_id
      WHERE mfm.scheme_code = $1
      LIMIT 1
    `, [schemeCode])

    if (info.length === 0) {
      return NextResponse.json({ error: 'Scheme not found' }, { status: 404 })
    }
    const meta = info[0]

    // 3 years of NAV history
    const { rows: navRows } = await client.query(`
      SELECT price_date, close_price
      FROM daily_prices
      WHERE security_id = $1
        AND price_date >= CURRENT_DATE - INTERVAL '3 years'
      ORDER BY price_date ASC
    `, [meta.security_id])

    const navHistory = navRows.map((r: any) => ({
      date: r.price_date instanceof Date
        ? r.price_date.toISOString().split('T')[0]
        : String(r.price_date).split('T')[0],
      nav: parseFloat(r.close_price),
    }))

    const latestNav = navHistory.at(-1)?.nav ?? null
    const today     = new Date()

    // Compute period returns from history
    function navDaysAgo(days: number): number | null {
      const target = new Date(today)
      target.setDate(target.getDate() - days)
      // Find closest available date on or before target
      const entry = [...navHistory]
        .reverse()
        .find(d => new Date(d.date) <= target)
      return entry?.nav ?? null
    }

    const returns: Record<string, number | null> = {}
    if (latestNav !== null) {
      const periods: [string, number][] = [
        ['1W', 7], ['1M', 30], ['3M', 90], ['6M', 182],
        ['1Y', 365], ['2Y', 730], ['3Y', 1095],
      ]
      for (const [label, days] of periods) {
        const past = navDaysAgo(days)
        if (past !== null) {
          returns[label] = days >= 365
            ? cagr(past, latestNav, days)
            : pointReturn(past, latestNav)
        } else {
          returns[label] = null
        }
      }
    }

    return NextResponse.json({
      meta: {
        schemeCode:      meta.scheme_code,
        schemeName:      meta.scheme_name,
        amcName:         meta.amc_name,
        schemeCategory:  meta.scheme_category,
        schemeType:      meta.scheme_type,
        plan:            meta.plan,
        option:          meta.option,
        isinGrowth:      meta.isin_growth,
        benchmark:       meta.benchmark,
      },
      currentNav: latestNav,
      returns,
      navHistory,
    })
  } finally {
    client.release()
  }
}
