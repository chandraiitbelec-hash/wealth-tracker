/**
 * Zerodha Equity Holdings Parser
 *
 * Supports both CSV and XLSX exports from Zerodha Console.
 * Format: flat table, headers on row 0
 * Columns: Instrument, Qty., Avg. cost, LTP, Invested, Cur. val, P&L, Net chg., Day chg.
 *
 * Key difference from Groww: no ISIN — we match by symbol in the enrich step.
 */

import * as XLSX from 'xlsx'
import { StockHolding } from '@/types/portfolio'

function parseNum(v: any): number {
  if (v === null || v === undefined || v === '') return 0
  const n = parseFloat(String(v).replace(/,/g, '').trim())
  return isNaN(n) ? 0 : n
}

export function parseZerodhaStocks(buffer: ArrayBuffer): { holdings: StockHolding[]; clientName: string } {
  const wb = XLSX.read(buffer, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  if (rows.length < 2) return { holdings: [], clientName: '' }

  // Find header row — look for "Instrument" column
  let headerRowIdx = 0
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (rows[i].some((c: any) => String(c).trim() === 'Instrument')) {
      headerRowIdx = i
      break
    }
  }

  const headers = rows[headerRowIdx].map((h: any) => String(h).trim())
  const col = (name: string) => headers.indexOf(name)

  const iCol       = col('Instrument')
  const qtyCol     = col('Qty.')
  const avgCol     = col('Avg. cost')
  const ltpCol     = col('LTP')
  const investCol  = col('Invested')
  const curValCol  = col('Cur. val')
  const pnlCol     = col('P&L')
  const netChgCol  = col('Net chg.')

  if (iCol === -1) throw new Error('Not a valid Zerodha holdings file — "Instrument" column not found')

  const holdings: StockHolding[] = []

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r]
    const symbol = String(row[iCol] ?? '').trim()
    if (!symbol || symbol.toLowerCase() === 'total') continue

    const quantity     = parseNum(row[qtyCol])
    const avgBuyPrice  = parseNum(row[avgCol])
    const closingPrice = parseNum(row[ltpCol])
    const buyValue     = parseNum(row[investCol]) || quantity * avgBuyPrice
    const closingValue = parseNum(row[curValCol]) || quantity * closingPrice
    const unrealisedPnL = parseNum(row[pnlCol]) || closingValue - buyValue
    const pnlPercent   = parseNum(row[netChgCol]) || (buyValue > 0 ? ((closingValue - buyValue) / buyValue) * 100 : 0)

    holdings.push({
      stockName:    symbol,
      symbol:       symbol,
      isin:         '',        // Zerodha doesn't export ISIN — enriched by symbol
      quantity,
      avgBuyPrice,
      buyValue,
      closingPrice,
      closingValue,
      unrealisedPnL,
      pnlPercent,
      enriched:     false,
    })
  }

  return { holdings, clientName: '' }
}

/** Detect if an ArrayBuffer looks like a Zerodha holdings file */
export function isZerodhaStocksFile(buffer: ArrayBuffer): boolean {
  try {
    const wb = XLSX.read(buffer, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
    return rows.slice(0, 5).some(row =>
      row.some((c: any) => String(c).trim() === 'Instrument') &&
      row.some((c: any) => String(c).trim() === 'Qty.')
    )
  } catch { return false }
}
