import { StockHolding, MFHolding, PortfolioSummary, AllocationSlice, ParsedPortfolio } from '@/types/portfolio'

const ALLOCATION_COLORS = [
  '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6',
]

export function buildPortfolioSummary(
  stocks: StockHolding[],
  mf: MFHolding[]
): PortfolioSummary {
  const stocksInvested = stocks.reduce((s, h) => s + h.buyValue, 0)
  const stocksCurrentValue = stocks.reduce((s, h) => s + h.closingValue, 0)
  const stocksPnL = stocksCurrentValue - stocksInvested

  const mfInvested = mf.reduce((s, h) => s + h.investedValue, 0)
  const mfCurrentValue = mf.reduce((s, h) => s + h.currentValue, 0)
  const mfReturns = mfCurrentValue - mfInvested

  const totalInvested = stocksInvested + mfInvested
  const totalCurrentValue = stocksCurrentValue + mfCurrentValue
  const totalPnL = totalCurrentValue - totalInvested

  return {
    stocksInvested,
    stocksCurrentValue,
    stocksPnL,
    stocksPnLPercent: stocksInvested > 0 ? (stocksPnL / stocksInvested) * 100 : 0,
    mfInvested,
    mfCurrentValue,
    mfReturns,
    mfReturnsPercent: mfInvested > 0 ? (mfReturns / mfInvested) * 100 : 0,
    totalInvested,
    totalCurrentValue,
    totalPnL,
    totalPnLPercent: totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0,
    stockCount: stocks.length,
    mfCount: mf.length,
  }
}

export function buildAssetAllocation(
  stocks: StockHolding[],
  mf: MFHolding[]
): AllocationSlice[] {
  const totalValue =
    stocks.reduce((s, h) => s + h.closingValue, 0) +
    mf.reduce((s, h) => s + h.currentValue, 0)

  if (totalValue === 0) return []

  // Group MF by category
  const mfByCategory: Record<string, number> = {}
  for (const h of mf) {
    const cat = h.category || 'Other'
    mfByCategory[cat] = (mfByCategory[cat] || 0) + h.currentValue
  }

  const slices: { name: string; value: number }[] = [
    { name: 'Direct Equity', value: stocks.reduce((s, h) => s + h.closingValue, 0) },
    ...Object.entries(mfByCategory).map(([name, value]) => ({
      name: `MF - ${name}`,
      value,
    })),
  ]

  return slices
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((s, i) => ({
      ...s,
      percent: (s.value / totalValue) * 100,
      color: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length],
    }))
}

export function buildMFCategoryAllocation(mf: MFHolding[]): AllocationSlice[] {
  const total = mf.reduce((s, h) => s + h.currentValue, 0)
  if (total === 0) return []

  const bySubCat: Record<string, number> = {}
  for (const h of mf) {
    const key = h.subCategory || h.category || 'Other'
    bySubCat[key] = (bySubCat[key] || 0) + h.currentValue
  }

  return Object.entries(bySubCat)
    .sort(([, a], [, b]) => b - a)
    .map(([name, value], i) => ({
      name,
      value,
      percent: (value / total) * 100,
      color: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length],
    }))
}

export function buildParsedPortfolio(
  stocks: StockHolding[],
  mf: MFHolding[],
  statementDate: string
): ParsedPortfolio {
  return {
    stocks,
    mutualFunds: mf,
    summary: buildPortfolioSummary(stocks, mf),
    assetAllocation: buildAssetAllocation(stocks, mf),
    mfCategoryAllocation: buildMFCategoryAllocation(mf),
    uploadedAt: new Date().toISOString(),
    statementDate,
  }
}

export function fmt(value: number, decimals = 2): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}

export function fmtCurrency(value: number): string {
  if (Math.abs(value) >= 10_000_000) return `₹${fmt(value / 10_000_000)}Cr`
  if (Math.abs(value) >= 100_000) return `₹${fmt(value / 100_000)}L`
  return `₹${fmt(value)}`
}
