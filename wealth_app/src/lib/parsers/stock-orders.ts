/**
 * Stock Order History Parser — multi-format
 *
 * Supports:
 *   1. Groww Stocks Order History XLSX
 *      Headers: Stock name | Symbol | ISIN | Type | Quantity | Value |
 *               Exchange | Exchange Order Id | Execution date and time | Order status
 *      Date: "01-04-2026 01:04 PM", Type: BUY/SELL, Status: Executed
 *
 *   2. Zerodha Equity Tradebook XLSX
 *      Sheet: "EQ" or first sheet
 *      Headers: symbol | isin | trade_date | exchange | segment | series |
 *               trade_type | auction | quantity | price | trade_id | order_id | order_execution_time
 */

import * as XLSX from 'xlsx'

export interface StockOrder {
  date: string          // ISO YYYY-MM-DD
  symbol: string
  isin: string
  stockName: string
  type: 'BUY' | 'SELL'
  quantity: number
  price: number         // per share (value / quantity)
  totalValue: number    // gross value of the trade
  exchange?: string
}

type Format = 'groww-stocks' | 'zerodha-eq' | 'unknown'

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTH_MAP: Record<string, number> = {
  jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11
}

function parseDate(raw: any): Date | null {
  if (!raw) return null
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw
  const s = String(raw).trim()
  // "01-04-2026 01:04 PM" or "01-04-2026"
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})/)
  if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1])
  // "2026-04-15"
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (ymd) return new Date(+ymd[1], +ymd[2] - 1, +ymd[3])
  // "03 Jun 2026"
  const dmy2 = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/)
  if (dmy2) {
    const mon = MONTH_MAP[dmy2[2].toLowerCase()]
    if (mon !== undefined) return new Date(+dmy2[3], mon, +dmy2[1])
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function toNum(v: any): number {
  if (v === null || v === undefined || v === '') return 0
  return parseFloat(String(v).replace(/[₹,\s]/g, '')) || 0
}

function detectFormat(rows: any[][]): Format {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const cells = rows[i].map((c: any) => String(c ?? '').toLowerCase().trim())
    if (cells.some(c => c === 'stock name') && cells.some(c => c === 'order status')) return 'groww-stocks'
    if (cells.some(c => c === 'trade_type' || c === 'trade type') && cells.some(c => c === 'series')) return 'zerodha-eq'
  }
  return 'unknown'
}

// ── Groww parser ──────────────────────────────────────────────────────────────

function parseGrowwOrders(rows: any[][]): StockOrder[] {
  let headerIdx = -1, headers: string[] = []
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const cells = rows[i].map((c: any) => String(c ?? '').toLowerCase().trim())
    if (cells.some(c => c === 'stock name') && cells.some(c => c === 'isin')) {
      headerIdx = i; headers = cells; break
    }
  }
  if (headerIdx === -1) return []

  const col = (keys: string[]) => headers.findIndex(h => keys.some(k => h === k || h.includes(k)))
  const nameCol   = col(['stock name'])
  const symCol    = col(['symbol'])
  const isinCol   = col(['isin'])
  const typeCol   = col(['type'])
  const qtyCol    = col(['quantity'])
  const valCol    = col(['value'])
  const dateCol   = col(['execution date', 'date'])
  const statusCol = col(['order status', 'status'])
  const exchCol   = col(['exchange'])

  const orders: StockOrder[] = []
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    const name   = String(row[nameCol]   ?? '').trim()
    const symbol = String(row[symCol]    ?? '').trim()
    const isin   = String(row[isinCol]   ?? '').trim()
    const type   = String(row[typeCol]   ?? '').toUpperCase().trim() as 'BUY' | 'SELL'
    const status = String(row[statusCol] ?? '').toLowerCase()

    if (!symbol || !type) continue
    if (status && !status.includes('execut')) continue  // skip cancelled/rejected

    const date = parseDate(row[dateCol])
    if (!date) continue

    const qty   = toNum(row[qtyCol])
    const total = toNum(row[valCol])
    if (qty === 0) continue

    orders.push({
      date:       date.toISOString().split('T')[0],
      symbol,
      isin,
      stockName:  name || symbol,
      type:       type === 'SELL' ? 'SELL' : 'BUY',
      quantity:   qty,
      price:      total / qty,
      totalValue: total,
      exchange:   exchCol !== -1 ? String(row[exchCol] ?? '').trim() : undefined,
    })
  }
  return orders
}

// ── Zerodha parser ────────────────────────────────────────────────────────────

function parseZerodhaOrders(rows: any[][]): StockOrder[] {
  let headerIdx = -1, headers: string[] = []
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const cells = rows[i].map((c: any) => String(c ?? '').toLowerCase().trim())
    if ((cells.includes('trade_type') || cells.includes('trade type')) && cells.includes('quantity')) {
      headerIdx = i; headers = cells; break
    }
  }
  if (headerIdx === -1) return []

  const col = (keys: string[]) => headers.findIndex(h => keys.some(k => h === k))
  const symCol    = col(['symbol'])
  const isinCol   = col(['isin'])
  const dateCol   = col(['trade_date', 'trade date'])
  const typeCol   = col(['trade_type', 'trade type'])
  const qtyCol    = col(['quantity'])
  const priceCol  = col(['price'])
  const exchCol   = col(['exchange'])

  const orders: StockOrder[] = []
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    const symbol = String(row[symCol]  ?? '').trim()
    const type   = String(row[typeCol] ?? '').toUpperCase().trim()
    if (!symbol || !type) continue

    const date = parseDate(row[dateCol])
    if (!date) continue

    const qty   = toNum(row[qtyCol])
    const price = toNum(row[priceCol])
    if (qty === 0) continue

    orders.push({
      date:       date.toISOString().split('T')[0],
      symbol,
      isin:       String(row[isinCol] ?? '').trim(),
      stockName:  symbol,
      type:       type.includes('SELL') ? 'SELL' : 'BUY',
      quantity:   qty,
      price,
      totalValue: qty * price,
      exchange:   exchCol !== -1 ? String(row[exchCol] ?? '').trim() : undefined,
    })
  }
  return orders
}

// ── Main export ───────────────────────────────────────────────────────────────

export function parseStockOrders(buffer: ArrayBuffer): StockOrder[] {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })

  // Zerodha equity tradebook uses sheet named "EQ", Groww uses "Sheet1"
  const sheetName = wb.SheetNames.find(s => s === 'EQ') ?? wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

  const fmt = detectFormat(rows)
  if (fmt === 'groww-stocks')  return parseGrowwOrders(rows)
  if (fmt === 'zerodha-eq')    return parseZerodhaOrders(rows)

  // Fallback: try both
  const groww = parseGrowwOrders(rows)
  if (groww.length > 0) return groww
  return parseZerodhaOrders(rows)
}

/** Filter to SELL orders within last N months */
export function recentSells(orders: StockOrder[], months = 12): StockOrder[] {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)
  return orders.filter(o => o.type === 'SELL' && new Date(o.date) >= cutoff)
}
