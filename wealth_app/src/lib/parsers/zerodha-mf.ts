/**
 * Zerodha MF P&L Report Parser
 *
 * Parses Zerodha's "P&L Statement for Mutual Funds" XLSX file.
 * This single file gives us both:
 *   1. Current MF holdings (Open Quantity, Open Value, NAV, Unrealized P&L)
 *   2. FY-specific buy values for accurate ELSS 80C calculation
 *
 * Header row columns (row 29 in typical export):
 *   Symbol | ISIN | Quantity | Buy Value | Sell Value | Realized P&L |
 *   Realized P&L Pct. | Previous Closing Price | Open Quantity |
 *   Open Quantity Type | Open Value | Unrealized P&L | Unrealized P&L Pct.
 */

import * as XLSX from 'xlsx'
import { MFHolding } from '@/types/portfolio'

export interface ZerodhaFYData {
  financialYear: string        // e.g. "2024-25"
  periodStart: string          // e.g. "2024-04-01"
  periodEnd: string            // e.g. "2025-03-31"
  isFullFY: boolean            // true if period = Apr 1 → Mar 31
  elssInvestedInFY: number     // sum of Buy Value for ELSS funds
  elssFunds: { schemeName: string; isin: string; invested: number }[]
}

export interface ZerodhaParseResult {
  holdings: MFHolding[]
  clientId: string
  fyData: ZerodhaFYData | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function isElss(schemeName: string): boolean {
  const lower = schemeName.toLowerCase()
  return lower.includes('elss') || lower.includes('tax saver') || lower.includes('tax saving')
}

function detectCategory(schemeName: string): string {
  const lower = schemeName.toLowerCase()
  if (lower.includes('overnight') || lower.includes('liquid') || lower.includes('debt') ||
      lower.includes('bond') || lower.includes('gilt') || lower.includes('income') ||
      lower.includes('money market') || lower.includes('ultra short') || lower.includes('low duration')) {
    return 'Debt'
  }
  if (lower.includes('gold') || lower.includes('silver') || lower.includes('commodity')) {
    return 'Commodity'
  }
  if (lower.includes('hybrid') || lower.includes('balanced') || lower.includes('arbitrage') ||
      lower.includes('multi asset') || lower.includes('dynamic asset')) {
    return 'Hybrid'
  }
  return 'Equity'
}

/** Extract financial year label from a date range string like "2025-04-01 to 2026-03-31" */
function parseFYFromRange(rangeStr: string): ZerodhaFYData['financialYear'] | null {
  const match = rangeStr.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  const year = parseInt(match[1])
  const month = parseInt(match[2])
  if (month >= 4) return `${year}-${String(year + 1).slice(2)}`
  return `${year - 1}-${String(year).slice(2)}`
}

function toNum(v: any): number {
  if (v === null || v === undefined || v === '') return 0
  return parseFloat(String(v)) || 0
}

// ── Detection ──────────────────────────────────────────────────────────────────

export function isZerodhaFundFile(buffer: ArrayBuffer): boolean {
  try {
    const wb = XLSX.read(buffer, { type: 'array' })
    return wb.SheetNames.includes('Mutual Funds')
  } catch {
    return false
  }
}

// ── Parser ────────────────────────────────────────────────────────────────────

export function parseZerodhaFunds(buffer: ArrayBuffer): ZerodhaParseResult {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  const ws = wb.Sheets['Mutual Funds']
  if (!ws) throw new Error('No "Mutual Funds" sheet found in this file')

  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

  let clientId = ''
  let periodStart = ''
  let periodEnd   = ''
  let headerRowIdx = -1

  // Scan metadata rows
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((c: any) => String(c ?? '').trim())

    // Client ID
    if (cells[1] === 'Client ID') clientId = cells[2]

    // Period — "P&L Statement for Mutual Funds from YYYY-MM-DD to YYYY-MM-DD"
    const periodMatch = cells.join(' ').match(/from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/)
    if (periodMatch) {
      periodStart = periodMatch[1]
      periodEnd   = periodMatch[2]
    }

    // Header row — contains "Symbol" and "ISIN"
    if (cells[1] === 'Symbol' && cells[2] === 'ISIN') {
      headerRowIdx = i
      break
    }
  }

  if (headerRowIdx === -1) throw new Error('Could not find data table in Zerodha MF file')

  const headers = rows[headerRowIdx].map((c: any) => String(c ?? '').toLowerCase().trim())
  const col = (keywords: string[]): number =>
    headers.findIndex(h => keywords.some(k => h.includes(k)))

  const symbolCol      = col(['symbol'])
  const isinCol        = col(['isin'])
  const buyValueCol    = col(['buy value'])
  const navCol         = col(['previous closing price', 'closing price'])
  const openQtyCol     = col(['open quantity'])
  const openValueCol   = col(['open value'])
  const unrealPnLCol   = col(['unrealized p&l', 'unrealised p&l'])
  const unrealPctCol   = col(['unrealized p&l pct', 'unrealised p&l pct'])

  const holdings: MFHolding[] = []
  const elssFunds: ZerodhaFYData['elssFunds'] = []

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    const schemeName = String(row[symbolCol] ?? '').trim()
    if (!schemeName) continue

    const isin        = String(row[isinCol] ?? '').trim()
    const nav         = toNum(row[navCol])
    const openQty     = toNum(row[openQtyCol])
    const openValue   = toNum(row[openValueCol])
    const buyValue    = toNum(row[buyValueCol])
    const unrealPnL   = toNum(row[unrealPnLCol])
    const unrealPct   = toNum(row[unrealPctCol])

    // Only include funds with current holdings
    if (openQty === 0 && openValue === 0) continue

    const currentValue = nav > 0 ? nav * openQty : openValue + unrealPnL

    const category = detectCategory(schemeName)
    const isDirect = schemeName.toLowerCase().includes('direct')

    holdings.push({
      schemeName:    schemeName,
      isin:          isin || undefined,
      units:         openQty,
      nav:           nav || undefined,
      investedValue: openValue,
      currentValue:  currentValue,
      returns:       unrealPnL,
      xirr:          unrealPct ? `${unrealPct.toFixed(2)}%` : undefined,
      category:      category,
      plan:          isDirect ? 'Direct' : 'Regular',
      amc:           undefined,
      subCategory:   undefined,
      folioNo:       undefined,
      source:        'zerodha',
    } as unknown as MFHolding)

    // Track ELSS funds for 80C
    if (isElss(schemeName) && buyValue > 0) {
      elssFunds.push({ schemeName, isin, invested: buyValue })
    }
  }

  // Build FY data
  let fyData: ZerodhaFYData | null = null
  if (periodStart && periodEnd) {
    const fy = parseFYFromRange(`from ${periodStart}`)
    // Check if period covers a full financial year (Apr 1 → Mar 31)
    const isFullFY =
      periodStart.endsWith('-04-01') && periodEnd.endsWith('-03-31')

    fyData = {
      financialYear:    fy || periodStart.slice(0, 4),
      periodStart,
      periodEnd,
      isFullFY,
      elssInvestedInFY: elssFunds.reduce((s, f) => s + f.invested, 0),
      elssFunds,
    }
  }

  return { holdings, clientId, fyData }
}
