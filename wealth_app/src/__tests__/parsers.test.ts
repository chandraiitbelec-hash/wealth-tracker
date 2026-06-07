/**
 * Tests for lib/parsers/stock-orders.ts and lib/parsers/mf-transactions.ts
 *
 * We test the parsing logic with synthetic XLSX workbook data injected via
 * the XLSX library's in-memory builder utilities, avoiding any real file I/O.
 */

import { describe, it, expect, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { parseStockOrders } from '../lib/parsers/stock-orders'
import { parseMFTransactions } from '../lib/parsers/mf-transactions'

// ── XLSX helpers ──────────────────────────────────────────────────────────────

/**
 * Build an ArrayBuffer representing a single-sheet XLSX workbook from a
 * matrix of rows (first row = headers).
 */
function makeXlsx(rows: (string | number | null)[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return buf
}

/**
 * Build an XLSX with a specific sheet name.
 */
function makeXlsxNamed(sheetName: string, rows: (string | number | null)[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return buf
}

// ══════════════════════════════════════════════════════════════════════════════
// Stock Order Parser
// ══════════════════════════════════════════════════════════════════════════════

describe('parseStockOrders — Groww format', () => {
  const growwHeaders = [
    'Stock name', 'Symbol', 'ISIN', 'Type', 'Quantity', 'Value',
    'Exchange', 'Exchange Order Id', 'Execution date and time', 'Order status',
  ]

  it('parses a BUY order correctly', () => {
    const buf = makeXlsx([
      growwHeaders,
      ['Reliance Industries', 'RELIANCE', 'INE002A01018', 'BUY', 10, 25000,
       'NSE', 'ORD001', '01-04-2026 01:04 PM', 'Executed'],
    ])
    const orders = parseStockOrders(buf)
    expect(orders).toHaveLength(1)
    expect(orders[0].symbol).toBe('RELIANCE')
    expect(orders[0].type).toBe('BUY')
    expect(orders[0].quantity).toBe(10)
    expect(orders[0].totalValue).toBeCloseTo(25000)
    expect(orders[0].price).toBeCloseTo(2500)
  })

  it('parses a SELL order correctly', () => {
    const buf = makeXlsx([
      growwHeaders,
      ['Infosys', 'INFY', 'INE009A01021', 'SELL', 5, 8500,
       'NSE', 'ORD002', '15-06-2025 10:30 AM', 'Executed'],
    ])
    const orders = parseStockOrders(buf)
    expect(orders).toHaveLength(1)
    expect(orders[0].type).toBe('SELL')
    expect(orders[0].symbol).toBe('INFY')
  })

  it('skips non-Executed orders', () => {
    const buf = makeXlsx([
      growwHeaders,
      ['TCS', 'TCS', 'INE467B01029', 'BUY', 5, 10000,
       'NSE', 'ORD003', '01-04-2026 09:00 AM', 'Cancelled'],
    ])
    const orders = parseStockOrders(buf)
    expect(orders).toHaveLength(0)
  })

  it('parses dates to ISO format YYYY-MM-DD', () => {
    const buf = makeXlsx([
      growwHeaders,
      ['HDFC Bank', 'HDFCBANK', 'INE040A01034', 'BUY', 2, 3600,
       'NSE', 'ORD004', '15-03-2025 02:15 PM', 'Executed'],
    ])
    const orders = parseStockOrders(buf)
    expect(orders[0].date).toBe('2025-03-15')
  })

  it('handles multiple rows', () => {
    const buf = makeXlsx([
      growwHeaders,
      ['Reliance', 'RELIANCE', 'INE002A01018', 'BUY', 10, 25000, 'NSE', 'O1', '01-04-2026 10:00 AM', 'Executed'],
      ['TCS',      'TCS',      'INE467B01029', 'BUY', 5,  10000, 'NSE', 'O2', '02-04-2026 11:00 AM', 'Executed'],
      ['INFY',     'INFY',     'INE009A01021', 'SELL',3,  5100,  'NSE', 'O3', '03-04-2026 12:00 PM', 'Executed'],
    ])
    const orders = parseStockOrders(buf)
    expect(orders).toHaveLength(3)
  })

  it('returns empty array for empty sheet', () => {
    const buf = makeXlsx([growwHeaders])
    const orders = parseStockOrders(buf)
    expect(orders).toHaveLength(0)
  })
})

describe('parseStockOrders — Zerodha format', () => {
  const zerodhaHeaders = [
    'symbol', 'isin', 'trade_date', 'exchange', 'segment', 'series',
    'trade_type', 'auction', 'quantity', 'price', 'trade_id', 'order_id', 'order_execution_time',
  ]

  it('parses a BUY trade', () => {
    const buf = makeXlsxNamed('EQ', [
      zerodhaHeaders,
      ['RELIANCE', 'INE002A01018', '2026-04-01', 'NSE', 'EQ', 'EQ', 'buy', 'N', 10, 2500, 'T1', 'O1', '2026-04-01T09:15:00'],
    ])
    const orders = parseStockOrders(buf)
    expect(orders).toHaveLength(1)
    expect(orders[0].symbol).toBe('RELIANCE')
    expect(orders[0].type).toBe('BUY')
    expect(orders[0].price).toBeCloseTo(2500)
    expect(orders[0].quantity).toBe(10)
  })

  it('parses a SELL trade', () => {
    const buf = makeXlsxNamed('EQ', [
      zerodhaHeaders,
      ['INFY', 'INE009A01021', '2025-06-15', 'NSE', 'EQ', 'EQ', 'sell', 'N', 5, 1700, 'T2', 'O2', '2025-06-15T10:00:00'],
    ])
    const orders = parseStockOrders(buf)
    expect(orders[0].type).toBe('SELL')
  })

  it('normalises trade_type to uppercase BUY/SELL', () => {
    const buf = makeXlsxNamed('EQ', [
      zerodhaHeaders,
      ['TCS', 'INE467B01029', '2026-01-10', 'NSE', 'EQ', 'EQ', 'buy', 'N', 2, 4000, 'T3', 'O3', '2026-01-10T09:30:00'],
    ])
    const orders = parseStockOrders(buf)
    expect(orders[0].type).toBe('BUY')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// MF Transaction Parser
// ══════════════════════════════════════════════════════════════════════════════

describe('parseMFTransactions — Groww format', () => {
  const growwMFHeaders = ['Scheme Name', 'Transaction Type', 'Units', 'NAV', 'Amount', 'Date']

  it('parses a SIP purchase correctly', () => {
    const buf = makeXlsxNamed('Transactions', [
      growwMFHeaders,
      ['Mirae Asset Large Cap Fund', 'SIP', 10.234, 96.5, '1,000', '03 Jun 2026'],
    ])
    const txns = parseMFTransactions(buf)
    expect(txns).toHaveLength(1)
    expect(txns[0].schemeName).toContain('Mirae')
    expect(txns[0].units).toBeCloseTo(10.234)
    expect(txns[0].amount).toBeCloseTo(1000)
  })

  it('parses a redemption correctly', () => {
    const buf = makeXlsxNamed('Transactions', [
      growwMFHeaders,
      ['Axis ELSS Fund', 'Redeem', 5, 120.0, '600', '01 Apr 2026'],
    ])
    const txns = parseMFTransactions(buf)
    expect(txns[0].transactionType).toMatch(/REDEEM|REDEMPTION/i)
  })

  it('handles amount strings with commas', () => {
    const buf = makeXlsxNamed('Transactions', [
      growwMFHeaders,
      ['HDFC Mid Cap Fund', 'SIP', 15.0, 80.0, '1,500', '15 May 2025'],
    ])
    const txns = parseMFTransactions(buf)
    expect(txns[0].amount).toBeCloseTo(1500)
  })

  it('parses dates to ISO format', () => {
    const buf = makeXlsxNamed('Transactions', [
      growwMFHeaders,
      ['Test Fund', 'Purchase', 10, 100, '1000', '15 Mar 2025'],
    ])
    const txns = parseMFTransactions(buf)
    expect(txns[0].date).toBe('2025-03-15')
  })

  it('returns empty array for empty sheet', () => {
    const buf = makeXlsxNamed('Transactions', [growwMFHeaders])
    const txns = parseMFTransactions(buf)
    expect(txns).toHaveLength(0)
  })

  it('handles multiple transactions', () => {
    const buf = makeXlsxNamed('Transactions', [
      growwMFHeaders,
      ['Fund A', 'SIP',     10, 100, '1000', '01 Apr 2025'],
      ['Fund B', 'SIP',     20, 50,  '1000', '01 May 2025'],
      ['Fund A', 'Redeem',  5,  110, '550',  '01 Jun 2025'],
    ])
    const txns = parseMFTransactions(buf)
    expect(txns).toHaveLength(3)
  })
})

describe('parseMFTransactions — Zerodha format', () => {
  it('parses Zerodha MF tradebook', () => {
    const headers = [
      'Symbol', 'ISIN', 'Trade Date', 'Exchange', 'Segment', 'Series',
      'Trade Type', 'Auction', 'Quantity', 'Price', 'Trade ID', 'Order ID', 'Order Execution Time',
    ]
    const buf = makeXlsxNamed('Mutual Funds', [
      ['Tradebook for Mutual Funds'],
      headers,
      ['HDFCMIDCAP', 'INF179K01WT7', '2025-06-01', 'BSE', 'MF', '', 'buy', 'N', 10, 95.5, 'T1', 'O1', '2025-06-01'],
    ])
    const txns = parseMFTransactions(buf)
    expect(txns.length).toBeGreaterThanOrEqual(1)
    expect(txns[0].amount).toBeCloseTo(955)
  })
})
