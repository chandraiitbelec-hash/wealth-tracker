import * as XLSX from 'xlsx'
import { StockHolding } from '@/types/portfolio'

/**
 * Groww Stocks Holdings Statement parser
 *
 * File structure:
 *   Row 0:  Name label + value
 *   Row 1:  Unique Client Code
 *   Rows 2–9: metadata / summary block
 *   Row 10: Column headers
 *   Row 11+: Holdings data rows
 *
 * Columns (0-indexed):
 *   0: Stock Name
 *   1: ISIN
 *   2: Quantity
 *   3: Average buy price
 *   4: Buy value
 *   5: Closing price
 *   6: Closing value
 *   7: Unrealised P&L
 */
export function parseGrowwStocks(buffer: ArrayBuffer): {
  holdings: StockHolding[]
  statementDate: string
  clientName: string
} {
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
  })

  // Extract metadata
  const clientName = String(rows[0]?.[1] ?? '').trim()

  // Extract statement date from the header row like "Holdings statement for stocks as on 06-06-2026"
  let statementDate = ''
  for (let i = 0; i < 10; i++) {
    const cell = String(rows[i]?.[0] ?? '')
    const match = cell.match(/as on\s+(\d{2}-\d{2}-\d{4})/i)
    if (match) {
      statementDate = match[1]
      break
    }
  }

  // Find the header row (contains "Stock Name" or "ISIN")
  let headerRowIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row && String(row[0] ?? '').toLowerCase().includes('stock name')) {
      headerRowIdx = i
      break
    }
  }

  if (headerRowIdx === -1) throw new Error('Could not find header row in stocks file')

  const holdings: StockHolding[] = []

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || !row[0]) continue

    const stockName = String(row[0] ?? '').trim()
    const isin = String(row[1] ?? '').trim()
    const quantity = parseFloat(String(row[2] ?? '0')) || 0
    const avgBuyPrice = parseFloat(String(row[3] ?? '0')) || 0
    const buyValue = parseFloat(String(row[4] ?? '0')) || 0
    const closingPrice = parseFloat(String(row[5] ?? '0')) || 0
    const closingValue = parseFloat(String(row[6] ?? '0')) || 0
    const unrealisedPnL = parseFloat(String(row[7] ?? '0')) || 0

    if (!isin || !stockName) continue

    holdings.push({
      stockName,
      isin,
      quantity,
      avgBuyPrice,
      buyValue,
      closingPrice,
      closingValue,
      unrealisedPnL,
      pnlPercent: buyValue > 0 ? (unrealisedPnL / buyValue) * 100 : 0,
    })
  }

  return { holdings, statementDate, clientName }
}
