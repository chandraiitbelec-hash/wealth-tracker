/**
 * POST /api/lookahead
 *
 * Computes "true" consolidated exposure by unbundling mutual fund holdings
 * into their underlying stocks, then merging with direct equity positions.
 *
 * Body:
 *   {
 *     stocks:  StockHolding[]   — direct equity positions (with closingValue)
 *     mf:      MFHolding[]      — MF positions (with currentValue, schemeCode)
 *   }
 *
 * Returns:
 *   {
 *     consolidatedHoldings: ConsolidatedHolding[]   — sorted by totalValue desc
 *     coverageRatio:        number                   — fraction of MF value with portfolio data
 *     latestDisclosureDate: string | null
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { pool } from '@/lib/db'

export const runtime = 'nodejs'

interface StockIn {
  isin?: string
  symbol?: string
  stockName?: string
  companyName?: string
  closingValue: number
}

interface MFIn {
  schemeCode?: string
  schemeName?: string
  currentValue: number
}

interface ConsolidatedHolding {
  isin: string
  name: string
  industry: string | null
  // Direct equity position
  directValue: number
  // Indirect exposure through MFs (sum across all funds)
  indirectValue: number
  // Total
  totalValue: number
  // As % of total portfolio net worth
  portfolioPct: number
  // Which MFs contribute to this exposure
  throughFunds: { fundName: string; exposure: number }[]
  isDirectHolding: boolean
}

export async function POST(req: NextRequest) {
  try {
    const { stocks = [], mf = [] }: { stocks: StockIn[]; mf: MFIn[] } = await req.json()

    const client = await pool.connect()
    try {
      // ── Total portfolio value ─────────────────────────────────────────
      const totalPortfolioValue =
        stocks.reduce((s: number, h: StockIn) => s + (h.closingValue ?? 0), 0) +
        mf.reduce((s: number, h: MFIn) => s + (h.currentValue ?? 0), 0)

      if (totalPortfolioValue === 0) {
        return NextResponse.json({ consolidatedHoldings: [], coverageRatio: 0, latestDisclosureDate: null })
      }

      // ── Build direct holding map keyed by ISIN ────────────────────────
      const directMap: Record<string, { name: string; value: number }> = {}
      for (const h of stocks) {
        const key = h.isin ?? h.symbol ?? ''
        if (!key) continue
        if (!directMap[key]) directMap[key] = { name: h.companyName ?? h.stockName ?? key, value: 0 }
        directMap[key].value += h.closingValue ?? 0
      }

      // ── Fetch scheme codes for MF holdings ───────────────────────────
      // schemeCode might already be present; if not, look up by name
      const schemeCodeSet: Set<string> = new Set()
      for (const h of mf) {
        if (h.schemeCode) schemeCodeSet.add(h.schemeCode)
      }

      // For funds without schemeCode, try name lookup
      const withoutCode = mf.filter((h: MFIn) => !h.schemeCode && h.schemeName)
      if (withoutCode.length > 0) {
        const names = withoutCode.map((h: MFIn) => h.schemeName!)
        const { rows } = await client.query(
          `SELECT scheme_code, scheme_name FROM mutual_fund_master WHERE scheme_name = ANY($1)`,
          [names]
        )
        const nameToCode: Record<string, string> = {}
        for (const r of rows) nameToCode[r.scheme_name] = r.scheme_code
        for (const h of withoutCode) {
          const code = nameToCode[h.schemeName!]
          // _resolvedCode is a transient field attached during this request to
          // carry the DB-resolved scheme code back to the coverage computation.
          // It is not part of the public MFIn interface — hence the cast.
          // TODO: lift _resolvedCode into a local Map<MFIn, string> to avoid mutating input objects.
          if (code) { (h as MFIn & { _resolvedCode: string })._resolvedCode = code; schemeCodeSet.add(code) }
        }
      }

      const schemeCodes = [...schemeCodeSet]

      // ── Fetch portfolio holdings for these funds from DB ──────────────
      let latestDisclosureDate: string | null = null
      const fundHoldings: Array<{
        schemeCode: string
        schemeName: string
        holdingIsin: string
        holdingName: string
        industry: string | null
        pctToNav: number
        disclosureDate: string
      }> = []

      let mfValueWithPortfolioData = 0

      if (schemeCodes.length > 0) {
        // Get the most recent disclosure for each fund
        const { rows } = await client.query(
          `
          SELECT
            mfm.scheme_code,
            mfm.scheme_name,
            fph.holding_isin,
            fph.holding_name,
            fph.industry,
            fph.pct_to_nav,
            fph.disclosure_date::text AS disclosure_date
          FROM fund_portfolio_holdings fph
          JOIN mutual_fund_master mfm ON mfm.security_id = fph.security_id
          JOIN LATERAL (
            SELECT MAX(disclosure_date) AS latest
            FROM fund_portfolio_holdings fph2
            WHERE fph2.security_id = fph.security_id
          ) latest_date ON fph.disclosure_date = latest_date.latest
          WHERE mfm.scheme_code = ANY($1)
            AND fph.pct_to_nav > 0
          ORDER BY mfm.scheme_code, fph.pct_to_nav DESC
          `,
          [schemeCodes]
        )

        for (const r of rows) {
          fundHoldings.push({
            schemeCode: r.scheme_code,
            schemeName: r.scheme_name,
            holdingIsin: r.holding_isin,
            holdingName: r.holding_name,
            industry: r.industry,
            pctToNav: parseFloat(r.pct_to_nav),
            disclosureDate: r.disclosure_date,
          })
          if (!latestDisclosureDate || r.disclosure_date > latestDisclosureDate) {
            latestDisclosureDate = r.disclosure_date
          }
        }

        // Compute coverage ratio: MF value where we have portfolio data
        const fundsWithData = new Set(fundHoldings.map(h => h.schemeCode))
        for (const h of mf) {
          const code = h.schemeCode ?? (h as MFIn & { _resolvedCode?: string })._resolvedCode
          if (code && fundsWithData.has(code)) mfValueWithPortfolioData += h.currentValue ?? 0
        }
      }

      const coverageRatio = mf.length > 0
        ? mfValueWithPortfolioData / mf.reduce((s: number, h: MFIn) => s + (h.currentValue ?? 0), 0)
        : 0

      // ── Compute indirect exposures ────────────────────────────────────
      // For each MF holding × each fund stock holding → indirect value
      const indirectMap: Record<string, {
        name: string
        industry: string | null
        value: number
        funds: { fundName: string; exposure: number }[]
      }> = {}

      // Build lookup: schemeCode → currentValue
      const mfValueByCode: Record<string, { value: number; name: string }> = {}
      for (const h of mf) {
        const code = h.schemeCode ?? (h as MFIn & { _resolvedCode?: string })._resolvedCode
        if (code) mfValueByCode[code] = { value: h.currentValue ?? 0, name: h.schemeName ?? code }
      }

      for (const fh of fundHoldings) {
        const fundInfo = mfValueByCode[fh.schemeCode]
        if (!fundInfo || fundInfo.value === 0) continue

        // User's exposure to this stock via this fund:
        //   (user's MF value) × (stock's % of fund NAV / 100)
        const exposure = fundInfo.value * (fh.pctToNav / 100)
        const key = fh.holdingIsin || fh.holdingName

        if (!indirectMap[key]) {
          indirectMap[key] = { name: fh.holdingName, industry: fh.industry, value: 0, funds: [] }
        }
        indirectMap[key].value += exposure
        indirectMap[key].funds.push({ fundName: fundInfo.name, exposure })
      }

      // ── Merge direct + indirect ───────────────────────────────────────
      const allKeys = new Set([...Object.keys(directMap), ...Object.keys(indirectMap)])
      const consolidated: ConsolidatedHolding[] = []

      for (const key of allKeys) {
        const direct   = directMap[key]
        const indirect = indirectMap[key]

        const directValue   = direct?.value ?? 0
        const indirectValue = indirect?.value ?? 0
        const totalValue    = directValue + indirectValue

        if (totalValue < 1) continue   // skip dust

        consolidated.push({
          isin:             key,
          name:             direct?.name ?? indirect?.name ?? key,
          industry:         indirect?.industry ?? null,
          directValue,
          indirectValue,
          totalValue,
          portfolioPct:     (totalValue / totalPortfolioValue) * 100,
          throughFunds:     indirect?.funds ?? [],
          isDirectHolding:  directValue > 0,
        })
      }

      // Sort by total exposure descending
      consolidated.sort((a, b) => b.totalValue - a.totalValue)

      return NextResponse.json({
        consolidatedHoldings: consolidated,
        coverageRatio,
        latestDisclosureDate,
        totalPortfolioValue,
      })
    } finally {
      client.release()
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Lookahead error:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
