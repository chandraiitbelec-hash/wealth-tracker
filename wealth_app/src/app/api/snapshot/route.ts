/**
 * POST /api/snapshot
 *
 * Saves a portfolio snapshot to the DB so the weekly digest job can
 * diff against it. Called automatically after a successful enrichment.
 *
 * Body:
 *   {
 *     userIdentifier: string        — broker client ID (e.g. "XU5116") or email
 *     portfolio:      ParsedPortfolio
 *   }
 *
 * The raw Excel files are never stored — only the computed numbers.
 */

import { NextRequest, NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const { userIdentifier, portfolio } = await req.json()
    if (!userIdentifier || !portfolio) {
      return NextResponse.json({ error: 'userIdentifier and portfolio are required' }, { status: 400 })
    }

    const summary = portfolio.summary ?? {}
    const today   = new Date().toISOString().split('T')[0]

    const client = await pool.connect()
    try {
      await client.query(
        `
        INSERT INTO portfolio_snapshots
          (user_identifier, snapshot_date, total_value, stocks_value, mf_value,
           total_invested, total_pnl, payload_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (user_identifier, snapshot_date)
        DO UPDATE SET
          total_value    = EXCLUDED.total_value,
          stocks_value   = EXCLUDED.stocks_value,
          mf_value       = EXCLUDED.mf_value,
          total_invested = EXCLUDED.total_invested,
          total_pnl      = EXCLUDED.total_pnl,
          payload_json   = EXCLUDED.payload_json
        `,
        [
          userIdentifier,
          today,
          summary.totalCurrentValue  ?? 0,
          summary.stocksCurrentValue ?? 0,
          summary.mfCurrentValue     ?? 0,
          summary.totalInvested      ?? 0,
          summary.totalPnL           ?? 0,
          JSON.stringify(portfolio),
        ]
      )
      return NextResponse.json({ saved: true, date: today })
    } finally {
      client.release()
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Snapshot save error:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
