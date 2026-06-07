/**
 * Tests for lib/portfolio.ts — formatting helpers, summary calculations,
 * allocation builders, and enrichment application.
 */

import { describe, it, expect } from 'vitest'
import {
  fmtCurrency,
  fmt,
  buildPortfolioSummary,
  buildAssetAllocation,
  buildSectorAllocation,
  buildMFCategoryAllocation,
} from '../lib/portfolio'
import type { StockHolding, MFHolding } from '../types/portfolio'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeStock(overrides: Partial<StockHolding> = {}): StockHolding {
  return {
    symbol: 'TEST',
    isin: 'INE000A01000',
    stockName: 'Test Corp',
    companyName: 'Test Corp Ltd',
    quantity: 10,
    closingPrice: 1000,
    ourPrice: 800,
    closingValue: 10_000,
    buyValue: 8_000,
    investedValue: 8_000,
    unrealisedPnL: 2_000,
    pnlPercent: 25,
    sector: 'Technology',
    industry: 'Software',
    marketCapCategory: 'LARGECAP',
    ...overrides,
  }
}

function makeMF(overrides: Partial<MFHolding> = {}): MFHolding {
  return {
    schemeName: 'Test MF',
    schemeCode: '12345',
    isin: 'INF000K01234',
    units: 100,
    nav: 50,
    currentValue: 5_000,
    investedValue: 4_000,
    unrealisedPnL: 1_000,
    returns: 25,
    category: 'Equity',
    ...overrides,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Formatting helpers
// ══════════════════════════════════════════════════════════════════════════════

describe('fmtCurrency', () => {
  it('formats values under ₹1L with comma notation', () => {
    expect(fmtCurrency(50_000)).toContain('50')
  })

  it('formats lakhs with L suffix', () => {
    const result = fmtCurrency(2_50_000)
    expect(result).toMatch(/2\.5.*L|2,50,000/)
  })

  it('formats crores with Cr suffix', () => {
    const result = fmtCurrency(1_00_00_000)
    expect(result).toMatch(/1.*Cr/)
  })

  it('handles zero', () => {
    expect(fmtCurrency(0)).toBeTruthy()
  })

  it('handles negative values', () => {
    const result = fmtCurrency(-50_000)
    expect(result).toContain('-')
  })
})

describe('fmt', () => {
  it('rounds to specified decimal places', () => {
    expect(fmt(3.14159, 2)).toBe('3.14')
  })

  it('handles zero decimals', () => {
    expect(fmt(42.7, 0)).toBe('43')
  })

  it('pads missing decimals', () => {
    expect(fmt(5, 2)).toBe('5.00')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Portfolio summary
// ══════════════════════════════════════════════════════════════════════════════

describe('buildPortfolioSummary', () => {
  it('sums stocks and MF current values correctly', () => {
    const stocks = [
      makeStock({ closingValue: 10_000, buyValue: 8_000 }),
      makeStock({ closingValue: 20_000, buyValue: 18_000 }),
    ]
    const mf = [makeMF({ currentValue: 5_000, investedValue: 4_000 })]

    const summary = buildPortfolioSummary(stocks, mf)

    expect(summary.stocksCurrentValue).toBe(30_000)
    expect(summary.mfCurrentValue).toBe(5_000)
    expect(summary.totalCurrentValue).toBe(35_000)
    expect(summary.totalInvested).toBe(30_000)
    expect(summary.totalPnL).toBe(5_000)
  })

  it('handles empty portfolio', () => {
    const summary = buildPortfolioSummary([], [])
    expect(summary.totalCurrentValue).toBe(0)
    expect(summary.totalPnL).toBe(0)
  })

  it('computes overall P&L percentage correctly', () => {
    const stocks = [makeStock({ closingValue: 12_000, buyValue: 10_000 })]
    const summary = buildPortfolioSummary(stocks, [])
    expect(summary.totalPnLPercent).toBeCloseTo(20)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Asset allocation
// ══════════════════════════════════════════════════════════════════════════════

describe('buildAssetAllocation', () => {
  it('assigns correct percentage to stocks and MF slices', () => {
    const stocks = [makeStock({ closingValue: 60_000 })]
    const mf     = [makeMF({ currentValue: 40_000 })]
    const slices = buildAssetAllocation(stocks, mf)

    const stockSlice = slices.find(s => s.name === 'Stocks' || s.name === 'Direct Equity')
    // value is raw currency; percent is the allocation percentage
    expect(stockSlice?.percent).toBeCloseTo(60, 0)
  })

  it('returns slices whose percentages sum to 100%', () => {
    const stocks = [makeStock({ closingValue: 75_000 })]
    const mf     = [makeMF({ currentValue: 25_000 })]
    const slices = buildAssetAllocation(stocks, mf)
    const total  = slices.reduce((s, x) => s + (x.percent ?? 0), 0)
    expect(total).toBeCloseTo(100, 0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Sector allocation
// ══════════════════════════════════════════════════════════════════════════════

describe('buildSectorAllocation', () => {
  it('groups holdings by sector and sums values', () => {
    const stocks = [
      makeStock({ sector: 'Technology', closingValue: 40_000 }),
      makeStock({ sector: 'Technology', closingValue: 20_000 }),
      makeStock({ sector: 'Banking',    closingValue: 30_000 }),
    ]
    const slices = buildSectorAllocation(stocks)

    const tech   = slices.find(s => s.name === 'Technology')
    const banking = slices.find(s => s.name === 'Banking')

    expect(tech?.value).toBeGreaterThan(banking!.value)
  })

  it('puts null/unknown sectors under Unknown', () => {
    const stocks = [
      // Both sector and industry must be null to get the 'Unknown' bucket
      makeStock({ sector: null, industry: null, closingValue: 10_000 }),
      makeStock({ sector: 'IT', closingValue: 10_000 }),
    ]
    const slices = buildSectorAllocation(stocks)
    expect(slices.find(s => s.name === 'Unknown')).toBeTruthy()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// MF category allocation
// ══════════════════════════════════════════════════════════════════════════════

describe('buildMFCategoryAllocation', () => {
  it('groups MFs by category', () => {
    const mf = [
      makeMF({ category: 'Equity', currentValue: 60_000 }),
      makeMF({ category: 'Debt',   currentValue: 20_000 }),
      makeMF({ category: 'Hybrid', currentValue: 20_000 }),
    ]
    const slices = buildMFCategoryAllocation(mf)

    const equity = slices.find(s => s.name === 'Equity')
    expect(equity).toBeTruthy()
    expect(equity!.value).toBeGreaterThan(slices.find(s => s.name === 'Debt')!.value)
  })

  it('returns empty array for no MF holdings', () => {
    expect(buildMFCategoryAllocation([])).toHaveLength(0)
  })
})
