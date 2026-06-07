/**
 * MF Transaction Statement Parser — multi-format
 *
 * Auto-detects and parses:
 *
 * 1. Groww MF Order History XLSX
 *    Sheet "Transactions"
 *    Headers: Scheme Name | Transaction Type | Units | NAV | Amount | Date
 *    Date: "03 Jun 2026", Amount: "1,499" (string with comma)
 *
 * 2. Zerodha MF Tradebook XLSX
 *    Sheet "Mutual Funds", row says "Tradebook for Mutual Funds"
 *    Headers: Symbol | ISIN | Trade Date | ... | Trade Type | ... | Quantity | Price | ...
 *    Amount derived from Quantity × Price
 *
 * Financial year: Apr 1 → Mar 31 (Indian FY)
 */

import * as XLSX from 'xlsx'

export interface MFTransaction {
  date: string             // ISO YYYY-MM-DD
  schemeName: string
  isin?: string
  transactionType: string  // normalised: PURCHASE | REDEMPTION | SIP | SWITCH_IN | etc.
  amount: number           // ₹
  units?: number
  nav?: number
}

export interface FYTransactionSummary {
  financialYear: string
  periodLabel: string
  elssInvestedInFY: number
  elssFunds: { schemeName: string; invested: number }[]
  allTransactions: MFTransaction[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

function isElss(name: string): boolean {
  const l = name.toLowerCase()
  return l.includes('elss') || l.includes('tax saver') || l.includes('tax saving')
}

function isPurchase(txType: string): boolean {
  const l = txType.toLowerCase()
  return l.includes('purchase') || l.includes('buy') || l.includes('sip') ||
         l.includes('switch in') || l.includes('dividend reinvest')
}

function getFY(date: Date): string {
  const y = date.getFullYear(), m = date.getMonth() + 1
  return m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`
}

function fyBounds(fy: string) {
  const y = parseInt(fy)
  return { start: new Date(y, 3, 1), end: new Date(y + 1, 2, 31, 23, 59, 59) }
}

function fyPeriodLabel(fy: string): string {
  const y = parseInt(fy)
  return `Apr ${y} – Mar ${y + 1}`
}

function parseDate(raw: any): Date | null {
  if (!raw) return null
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw

  const s = String(raw).trim()

  // "03 Jun 2026"
  const dMonY = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/)
  if (dMonY) {
    const mon = MONTH_MAP[dMonY[2].toLowerCase()]
    if (mon !== undefined) return new Date(+dMonY[3], mon, +dMonY[1])
  }
  // "2026-04-15" or ISO with time "2026-04-15T00:00:00"
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (ymd) return new Date(+ymd[1], +ymd[2] - 1, +ymd[3])
  // "01-04-2026"
  const dmy = s.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})/)
  if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1])

  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function toNum(raw: any): number {
  if (raw === null || raw === undefined || raw === '') return 0
  return parseFloat(String(raw).replace(/[₹,\s]/g, '')) || 0
}

function normaliseType(raw: string): string {
  const l = raw.toLowerCase().trim()
  if (l === 'buy' || l.includes('purchase') || l.includes('sip')) return 'PURCHASE'
  if (l === 'sell' || l.includes('redemption') || l.includes('redeem')) return 'REDEMPTION'
  if (l.includes('switch in'))  return 'SWITCH_IN'
  if (l.includes('switch out')) return 'SWITCH_OUT'
  return raw.toUpperCase()
}

// ── Format detectors ──────────────────────────────────────────────────────────

type Format = 'groww-mf-orders' | 'zerodha-tradebook' | 'unknown'

function detectFormat(rows: any[][]): Format {
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const cells = rows[i].map((c: any) => String(c ?? '').toLowerCase().trim())
    // Zerodha tradebook has "tradebook for mutual funds" in one of the first rows
    if (cells.some(c => c.includes('tradebook for mutual funds'))) return 'zerodha-tradebook'
    // Groww order history has a row with exactly "scheme name" and "amount" headers
    if (cells.includes('scheme name') && cells.includes('amount') && cells.includes('date')) {
      return 'groww-mf-orders'
    }
  }
  return 'unknown'
}

// ── Format-specific parsers ───────────────────────────────────────────────────

function parseGrowwMFOrders(rows: any[][]): MFTransaction[] {
  // Find header row
  let headerIdx = -1, headers: string[] = []
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const cells = rows[i].map((c: any) => String(c ?? '').toLowerCase().trim())
    if (cells.includes('scheme name') && cells.includes('amount')) {
      headerIdx = i; headers = cells; break
    }
  }
  if (headerIdx === -1) return []

  const col = (keys: string[]) => headers.findIndex(h => keys.some(k => h === k || h.includes(k)))
  const schemeCol = col(['scheme name'])
  const typeCol   = col(['transaction type', 'txn type'])
  const amountCol = col(['amount'])
  const dateCol   = col(['date'])
  const unitsCol  = col(['units'])
  const navCol    = col(['nav'])

  if (schemeCol === -1 || amountCol === -1 || dateCol === -1) return []

  const txns: MFTransaction[] = []
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    const scheme = String(row[schemeCol] ?? '').trim()
    if (!scheme || !row[dateCol]) continue

    const date = parseDate(row[dateCol])
    if (!date) continue

    const amount = toNum(row[amountCol])
    if (amount === 0) continue

    txns.push({
      date:            date.toISOString().split('T')[0],
      schemeName:      scheme,
      transactionType: normaliseType(String(row[typeCol] ?? 'PURCHASE')),
      amount,
      units: unitsCol !== -1 ? toNum(row[unitsCol]) || undefined : undefined,
      nav:   navCol   !== -1 ? toNum(row[navCol])   || undefined : undefined,
    })
  }
  return txns
}

function parseZerodhaTradebook(rows: any[][]): MFTransaction[] {
  // Find header row — contains "symbol", "trade date", "trade type"
  let headerIdx = -1, headers: string[] = []
  for (let i = 0; i < Math.min(25, rows.length); i++) {
    const cells = rows[i].map((c: any) => String(c ?? '').toLowerCase().trim())
    if (cells.includes('symbol') && cells.includes('trade date') && cells.includes('trade type')) {
      headerIdx = i; headers = cells; break
    }
  }
  if (headerIdx === -1) return []

  const col = (keys: string[]) => headers.findIndex(h => keys.some(k => h === k))
  const symbolCol    = col(['symbol'])
  const isinCol      = col(['isin'])
  const tradeDateCol = col(['trade date'])
  const tradeTypeCol = col(['trade type'])
  const qtyCol       = col(['quantity'])
  const priceCol     = col(['price'])

  if (symbolCol === -1 || tradeDateCol === -1 || qtyCol === -1 || priceCol === -1) return []

  const txns: MFTransaction[] = []
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    const scheme = String(row[symbolCol] ?? '').trim()
    if (!scheme || !row[tradeDateCol]) continue

    const date = parseDate(row[tradeDateCol])
    if (!date) continue

    const qty   = toNum(row[qtyCol])
    const price = toNum(row[priceCol])
    const amount = qty * price

    if (amount === 0) continue

    txns.push({
      date:            date.toISOString().split('T')[0],
      schemeName:      scheme,
      isin:            isinCol !== -1 ? String(row[isinCol] ?? '').trim() || undefined : undefined,
      transactionType: normaliseType(String(row[tradeTypeCol] ?? 'buy')),
      amount,
      units: qty   || undefined,
      nav:   price || undefined,
    })
  }
  return txns
}

// ── Main export ───────────────────────────────────────────────────────────────

export function parseMFTransactions(buffer: ArrayBuffer): MFTransaction[] {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })

  // Prefer "Transactions" (Groww) or "Mutual Funds" (Zerodha), else first sheet
  const sheetName =
    wb.SheetNames.includes('Transactions') ? 'Transactions' :
    wb.SheetNames.includes('Mutual Funds') ? 'Mutual Funds' :
    wb.SheetNames[0]

  const ws = wb.Sheets[sheetName]
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

  const format = detectFormat(rows)

  switch (format) {
    case 'groww-mf-orders':    return parseGrowwMFOrders(rows)
    case 'zerodha-tradebook':  return parseZerodhaTradebook(rows)
    default:
      // Generic fallback — try both parsers
      const groww = parseGrowwMFOrders(rows)
      if (groww.length > 0) return groww
      return parseZerodhaTradebook(rows)
  }
}

export function summariseELSSForFY(
  transactions: MFTransaction[],
  fyLabel?: string
): FYTransactionSummary {
  const now = new Date()
  const fy  = fyLabel || getFY(now)
  const { start, end } = fyBounds(fy)

  const purchases = transactions.filter(tx => {
    const d = new Date(tx.date)
    return d >= start && d <= end && isPurchase(tx.transactionType) && tx.amount > 0
  })

  const elssInFY = purchases.filter(tx => isElss(tx.schemeName))

  const byScheme: Record<string, number> = {}
  for (const tx of elssInFY) {
    byScheme[tx.schemeName] = (byScheme[tx.schemeName] || 0) + tx.amount
  }

  const elssFunds = Object.entries(byScheme)
    .map(([schemeName, invested]) => ({ schemeName, invested }))
    .sort((a, b) => b.invested - a.invested)

  return {
    financialYear:    fy,
    periodLabel:      fyPeriodLabel(fy),
    elssInvestedInFY: elssFunds.reduce((s, f) => s + f.invested, 0),
    elssFunds,
    allTransactions:  transactions,
  }
}
