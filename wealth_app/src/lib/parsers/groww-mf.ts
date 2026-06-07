import * as XLSX from 'xlsx'
import { MFHolding } from '@/types/portfolio'

/**
 * Groww Mutual Funds Holdings parser
 *
 * File structure (Holdings sheet):
 *   Rows 0–8:  blank / personal details block
 *   Rows 9–15: HOLDING SUMMARY block
 *   Rows 16–19: "HOLDINGS AS ON" date
 *   Row 20:    Column headers
 *   Row 21:    blank
 *   Row 22+:   Data rows
 *
 * Columns (0-indexed):
 *   0:  Scheme Name
 *   1:  AMC
 *   2:  Category
 *   3:  Sub-category
 *   4:  Folio No.
 *   5:  Source
 *   6:  Units
 *   7:  Invested Value
 *   8:  Current Value
 *   9:  Returns
 *   10: XIRR
 */
export function parseGrowwMF(buffer: ArrayBuffer): {
  holdings: MFHolding[]
  statementDate: string
  clientName: string
  totalInvested: number
  totalCurrentValue: number
} {
  const workbook = XLSX.read(buffer, { type: 'array' })
  // Prefer "Holdings" sheet, fall back to first sheet
  const sheetName = workbook.SheetNames.includes('Holdings')
    ? 'Holdings'
    : workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
  })

  // Extract client name
  let clientName = ''
  for (let i = 0; i < 10; i++) {
    if (String(rows[i]?.[0] ?? '').trim().toLowerCase() === 'name') {
      clientName = String(rows[i]?.[1] ?? '').trim()
      break
    }
  }

  // Extract statement date from "HOLDINGS AS ON YYYY-MM-DD"
  let statementDate = ''
  for (let i = 0; i < rows.length; i++) {
    const cell = String(rows[i]?.[0] ?? '')
    const match = cell.match(/holdings as on\s+(\d{4}-\d{2}-\d{2})/i)
    if (match) {
      statementDate = match[1]
      break
    }
  }

  // Extract portfolio totals from summary block
  let totalInvested = 0
  let totalCurrentValue = 0
  for (let i = 0; i < rows.length; i++) {
    const cell = String(rows[i]?.[0] ?? '').trim().toLowerCase()
    if (cell === 'total investments') {
      // Next row has the values
      const valRow = rows[i + 1]
      if (valRow) {
        totalInvested = parseFloat(String(valRow[0] ?? '0')) || 0
        totalCurrentValue = parseFloat(String(valRow[1] ?? '0')) || 0
      }
      break
    }
  }

  // Find header row
  let headerRowIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const cell = String(rows[i]?.[0] ?? '').trim().toLowerCase()
    if (cell === 'scheme name') {
      headerRowIdx = i
      break
    }
  }

  if (headerRowIdx === -1) throw new Error('Could not find header row in MF file')

  const holdings: MFHolding[] = []

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || !row[0]) continue

    const schemeName = String(row[0] ?? '').trim()
    if (!schemeName || schemeName.toLowerCase() === 'scheme name') continue

    const amc = String(row[1] ?? '').trim()
    const category = String(row[2] ?? '').trim()
    const subCategory = String(row[3] ?? '').trim()
    const folioNo = String(row[4] ?? '').trim()
    const source = String(row[5] ?? '').trim()
    const units = parseFloat(String(row[6] ?? '0')) || 0
    const investedValue = parseFloat(String(row[7] ?? '0')) || 0
    const currentValue = parseFloat(String(row[8] ?? '0')) || 0
    const returns = parseFloat(String(row[9] ?? '0')) || 0
    const xirr = String(row[10] ?? '').trim()

    holdings.push({
      schemeName,
      amc,
      category,
      subCategory,
      folioNo,
      source,
      units,
      investedValue,
      currentValue,
      returns,
      xirr,
    })
  }

  return { holdings, statementDate, clientName, totalInvested, totalCurrentValue }
}
