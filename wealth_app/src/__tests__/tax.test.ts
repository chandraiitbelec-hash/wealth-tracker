/**
 * Tests for lib/tax.ts — FIFO lot matching, STCG/LTCG classification,
 * tax report building, and sell plan optimisation.
 *
 * All tests use fixed dates relative to a mocked "today" so results
 * are deterministic regardless of when the suite runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildTaxReport, buildSellPlan } from '../lib/tax'
import type { StockOrder } from '../lib/parsers/stock-orders'
import type { StockHolding } from '../types/portfolio'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pin "today" so holdingDays calculations are stable. */
const TODAY = new Date('2025-06-01T00:00:00Z')

function daysAgo(n: number): string {
  const d = new Date(TODAY)
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}

function buy(symbol: string, date: string, qty: number, price: number): StockOrder {
  return { symbol, isin: '', date, quantity: qty, price, type: 'BUY' }
}

function sell(symbol: string, date: string, qty: number, price: number): StockOrder {
  return { symbol, isin: '', date, quantity: qty, price, type: 'SELL' }
}

function holding(
  symbol: string,
  qty: number,
  currentPrice: number,
  avgBuy: number
): StockHolding {
  return {
    symbol,
    isin: '',
    stockName: symbol,
    companyName: symbol,
    quantity: qty,
    closingPrice: currentPrice,
    ourPrice: avgBuy,
    closingValue: qty * currentPrice,
    investedValue: qty * avgBuy,
    unrealisedPnL: qty * (currentPrice - avgBuy),
    pnlPercent: ((currentPrice - avgBuy) / avgBuy) * 100,
    sector: null,
    industry: null,
    marketCapCategory: null,
  }
}

// ── Pin Date.now so daysSince() is deterministic ──────────────────────────────

beforeEach(() => {
  vi.setSystemTime(TODAY)
})
afterEach(() => {
  vi.useRealTimers()
})

// ══════════════════════════════════════════════════════════════════════════════
// FIFO lot matching
// ══════════════════════════════════════════════════════════════════════════════

describe('FIFO lot matching', () => {
  it('single buy, no sells — full lot remains open', () => {
    const orders  = [buy('RELIANCE', daysAgo(400), 10, 2000)]
    const holdings = [holding('RELIANCE', 10, 2500, 2000)]
    const report  = buildTaxReport(orders, holdings)

    expect(report.bySymbol).toHaveLength(1)
    const sym = report.bySymbol[0]
    expect(sym.lots).toHaveLength(1)
    expect(sym.lots[0].quantity).toBe(10)
    expect(sym.lots[0].isLTCG).toBe(true)   // 400 days > 365
  })

  it('partial sell consumes oldest lot first', () => {
    // Two buys at different dates; sell 5 shares — should consume from first buy
    const orders = [
      buy('INFY', daysAgo(500), 10, 1500),
      buy('INFY', daysAgo(100), 5,  1700),
      sell('INFY', daysAgo(10), 5,  1800),
    ]
    const holdings = [holding('INFY', 10, 1900, 1600)]
    const report   = buildTaxReport(orders, holdings)

    const sym = report.bySymbol[0]
    // After consuming 5 from the first buy: 5 remain from first buy (LTCG), 5 from second (STCG)
    expect(sym.lots).toHaveLength(2)
    expect(sym.lots.find(l => l.isLTCG)?.quantity).toBe(5)
    expect(sym.lots.find(l => !l.isLTCG)?.quantity).toBe(5)
  })

  it('sell fully consumes first lot and partially second', () => {
    const orders = [
      buy('TCS', daysAgo(600), 8, 3000),
      buy('TCS', daysAgo(200), 10, 3200),
      sell('TCS', daysAgo(5), 10, 3500),   // consumes all 8 from first + 2 from second
    ]
    const holdings = [holding('TCS', 8, 3600, 3200)]
    const report   = buildTaxReport(orders, holdings)

    const sym = report.bySymbol[0]
    // Remaining: 8 shares from second buy (STCG)
    expect(sym.lots).toHaveLength(1)
    expect(sym.lots[0].quantity).toBe(8)
    expect(sym.lots[0].isLTCG).toBe(false)
  })

  it('caps open lots to current portfolio quantity', () => {
    // Orders claim 20 shares open but holding says 10 (pre-upload window sells)
    const orders   = [buy('WIPRO', daysAgo(400), 20, 400)]
    const holdings = [holding('WIPRO', 10, 500, 400)]
    const report   = buildTaxReport(orders, holdings)

    const total = report.bySymbol[0].lots.reduce((s, l) => s + l.quantity, 0)
    expect(total).toBe(10)
  })

  it('ignores symbols with no current holding', () => {
    const orders   = [buy('EXITED', daysAgo(100), 5, 200)]
    const holdings = [holding('RELIANCE', 10, 2500, 2000)]
    const report   = buildTaxReport(orders, holdings)

    expect(report.bySymbol.find(s => s.symbol === 'EXITED')).toBeUndefined()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// STCG / LTCG classification
// ══════════════════════════════════════════════════════════════════════════════

describe('STCG / LTCG classification', () => {
  it('lot held exactly 365 days is LTCG', () => {
    const orders   = [buy('A', daysAgo(365), 5, 100)]
    const holdings = [holding('A', 5, 120, 100)]
    const report   = buildTaxReport(orders, holdings)
    expect(report.bySymbol[0].lots[0].isLTCG).toBe(true)
  })

  it('lot held 364 days is STCG', () => {
    const orders   = [buy('B', daysAgo(364), 5, 100)]
    const holdings = [holding('B', 5, 120, 100)]
    const report   = buildTaxReport(orders, holdings)
    expect(report.bySymbol[0].lots[0].isLTCG).toBe(false)
  })

  it('correctly totals STCG and LTCG gains separately', () => {
    const orders = [
      buy('C', daysAgo(500), 10, 100),   // LTCG lot, gain = 10 × 50 = 500
      buy('C', daysAgo(100), 10, 100),   // STCG lot, gain = 10 × 50 = 500
    ]
    const holdings = [holding('C', 20, 150, 100)]
    const report   = buildTaxReport(orders, holdings)
    const sym = report.bySymbol[0]

    expect(sym.ltcgGain).toBeCloseTo(500)
    expect(sym.stcgGain).toBeCloseTo(500)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Tax calculations
// ══════════════════════════════════════════════════════════════════════════════

describe('tax report totals', () => {
  it('STCG tax is 20% of total short-term gain', () => {
    const orders   = [buy('X', daysAgo(100), 10, 1000)]
    const holdings = [holding('X', 10, 2000, 1000)]
    const report   = buildTaxReport(orders, holdings)

    expect(report.totalSTCGGain).toBeCloseTo(10_000)
    expect(report.estimatedSTCGTax).toBeCloseTo(2_000)   // 20%
  })

  it('LTCG gain under ₹1.25L is fully exempt', () => {
    const orders   = [buy('Y', daysAgo(400), 10, 1000)]
    const holdings = [holding('Y', 10, 2000, 1000)]
    const report   = buildTaxReport(orders, holdings)   // gain = ₹10,000

    expect(report.ltcgExemption).toBeCloseTo(10_000)    // fully covered by exemption
    expect(report.taxableLTCG).toBeCloseTo(0)
    expect(report.estimatedLTCGTax).toBeCloseTo(0)
  })

  it('LTCG above ₹1.25L is taxed at 12.5% on the excess', () => {
    const orders   = [buy('Z', daysAgo(400), 100, 1000)]
    const holdings = [holding('Z', 100, 2500, 1000)]
    // gain = 100 × 1500 = ₹1,50,000
    const report   = buildTaxReport(orders, holdings)

    expect(report.totalLTCGGain).toBeCloseTo(1_50_000)
    expect(report.ltcgExemption).toBeCloseTo(1_25_000)
    expect(report.taxableLTCG).toBeCloseTo(25_000)
    expect(report.estimatedLTCGTax).toBeCloseTo(3_125)   // 12.5% of ₹25,000
  })

  it('already-used LTCG exemption reduces available headroom', () => {
    const orders   = [buy('W', daysAgo(400), 10, 1000)]
    const holdings = [holding('W', 10, 2000, 1000)]
    // gain = ₹10,000; pass 1,20,000 already used → only ₹5,000 left
    const report   = buildTaxReport(orders, holdings, 1_20_000)

    expect(report.ltcgExemption).toBeCloseTo(5_000)
    expect(report.taxableLTCG).toBeCloseTo(5_000)
    expect(report.estimatedLTCGTax).toBeCloseTo(625)
  })

  it('losses do not produce negative tax', () => {
    const orders   = [buy('LOSS', daysAgo(100), 10, 2000)]
    const holdings = [holding('LOSS', 10, 1000, 2000)]
    const report   = buildTaxReport(orders, holdings)

    expect(report.estimatedSTCGTax).toBe(0)
    expect(report.totalEstimatedTax).toBe(0)
  })

  it('empty order history returns zeroed report', () => {
    const report = buildTaxReport([], [holding('A', 10, 100, 80)])
    expect(report.bySymbol).toHaveLength(0)
    expect(report.totalEstimatedTax).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Sell plan — tax-optimised ordering
// ══════════════════════════════════════════════════════════════════════════════

describe('buildSellPlan', () => {
  it('fills LTCG lots within exemption before STCG lots', () => {
    const orders = [
      buy('P', daysAgo(500), 5, 1000),   // LTCG, gain 5×1000=5000
      buy('P', daysAgo(50),  5, 1000),   // STCG, gain 5×1000=5000
    ]
    const holdings = [holding('P', 10, 2000, 1000)]
    const report   = buildTaxReport(orders, holdings)

    // Ask for ₹6,000 — can fill entirely from LTCG within exemption
    const plan = buildSellPlan(report, 6_000)
    const recs  = plan.recommendations

    // All recommendations should be LTCG
    expect(recs.every(r => r.isLTCG)).toBe(true)
    expect(plan.totalTax).toBeCloseTo(0)   // within ₹1.25L exemption
  })

  it('uses STCG lots only after LTCG exhausted or exemption used', () => {
    // Build a portfolio where LTCG gain alone can't meet target
    const orders = [
      buy('Q', daysAgo(500), 2, 1000),   // LTCG: 2 shares, gain 2×1000=2000
      buy('Q', daysAgo(50),  10, 1000),  // STCG: 10 shares
    ]
    const holdings = [holding('Q', 12, 2000, 1000)]
    const report   = buildTaxReport(orders, holdings)

    // Ask for ₹20,000 — LTCG (2×2000=₹4,000) isn't enough
    const plan = buildSellPlan(report, 20_000)
    const hasSTCG = plan.recommendations.some(r => !r.isLTCG)
    expect(hasSTCG).toBe(true)
  })

  it('total proceeds does not exceed target by more than one share', () => {
    const orders   = [buy('R', daysAgo(500), 100, 100)]
    const holdings = [holding('R', 100, 200, 100)]
    const report   = buildTaxReport(orders, holdings)
    const plan     = buildSellPlan(report, 5_000)

    // Proceeds should be ≤ target + one share's price
    expect(plan.totalProceeds).toBeLessThanOrEqual(5_000 + 200)
  })

  it('returns empty recommendations when no lots have price data', () => {
    const orders   = [buy('S', daysAgo(400), 10, 100)]
    // Holding with no currentPrice (closingPrice = null)
    const h: StockHolding = {
      ...holding('S', 10, 0, 100),
      closingPrice: null as unknown as number,
      ourPrice:     null as unknown as number,  // both price sources null
    }
    const report = buildTaxReport(orders, [h])
    const plan   = buildSellPlan(report, 10_000)

    expect(plan.recommendations).toHaveLength(0)
    expect(plan.totalProceeds).toBe(0)
  })

  it('correctly tracks LTCG exemption consumption across multiple lots', () => {
    // Large LTCG gain: ₹2,00,000 — only first ₹1,25,000 is exempt
    const orders   = [buy('T', daysAgo(400), 100, 1000)]
    const holdings = [holding('T', 100, 3000, 1000)]  // gain = ₹2,00,000
    const report   = buildTaxReport(orders, holdings)
    const plan     = buildSellPlan(report, 3_00_000)   // sell everything

    expect(plan.ltcgUsed).toBeCloseTo(1_25_000)
    expect(plan.ltcgRemaining).toBeCloseTo(0)
    // Tax = 12.5% of (₹2,00,000 − ₹1,25,000) = 12.5% of ₹75,000 = ₹9,375
    expect(plan.totalTax).toBeCloseTo(9_375)
  })
})
