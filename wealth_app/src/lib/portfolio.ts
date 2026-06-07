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

/**
 * Apply DB enrichment data onto parsed holdings.
 * Adds sector, company name, our live price/NAV, and recalculates P&L
 * using our own prices where available.
 */
/**
 * ETFs get NSE's AMC sector ("Financial Services") which is misleading.
 * Override based on what the ETF actually tracks.
 */
function resolveEtfSector(symbol: string, name: string): string | null {
  const s = (symbol + ' ' + name).toLowerCase()
  if (s.includes('gold'))    return 'Commodities – Gold ETF'
  if (s.includes('silver'))  return 'Commodities – Silver ETF'
  if (s.includes('nifty') || s.includes('sensex') || s.includes('bees') ||
      s.includes('niftybees') || s.includes('juniorbees') || s.includes('bankbees') ||
      s.includes('index') || s.includes('itetf') || s.includes('psubnkbees')) {
    return 'Equity Index ETF'
  }
  if (s.includes('liquid') || s.includes('overnight') || s.includes('debt')) return 'Debt ETF'
  return null
}

function isEtfLike(symbol: string, name: string): boolean {
  const s = (symbol + ' ' + name).toLowerCase()
  return s.endsWith('bees') || s.includes('etf') || s.includes('growwgold') ||
         s.includes('growwsilver') || s.includes('netf')
}

export function applyEnrichment(
  stocks: StockHolding[],
  mf: MFHolding[],
  stockEnrichment: Record<string, any>,
  mfEnrichment: Record<string, any>
): { stocks: StockHolding[]; mf: MFHolding[] } {
  const enrichedStocks = stocks.map((h) => {
    // Groww: keyed by ISIN. Zerodha: keyed by symbol (no ISIN available)
    const e = stockEnrichment[h.isin] ?? stockEnrichment[h.symbol ?? ''] ?? null
    if (!e) return h

    const ourPrice = e.our_price ? parseFloat(e.our_price) : null
    const ourValue = ourPrice ? ourPrice * h.quantity : null
    const ourPnL = ourValue ? ourValue - h.buyValue : null

    const sym  = (e.symbol ?? h.symbol ?? h.stockName ?? '')
    const name = (e.company_name ?? h.stockName ?? '')
    const etfSector = isEtfLike(sym, name) ? resolveEtfSector(sym, name) : null

    return {
      ...h,
      symbol:            sym,
      companyName:       name,
      sector:            etfSector ?? e.sector ?? undefined,
      industry:          etfSector ?? e.industry ?? undefined,
      marketCapCategory: e.market_cap_category ?? undefined,
      ourPrice:          ourPrice ?? undefined,
      ourValue:          ourValue ?? undefined,
      ourPnL:            ourPnL ?? undefined,
      ourPnLPercent:     ourPnL && h.buyValue > 0 ? (ourPnL / h.buyValue) * 100 : undefined,
      priceDate:         e.price_date ?? undefined,
      enriched:          true,
    }
  })

  const enrichedMf = mf.map((h) => {
    const e = mfEnrichment[h.schemeName]
    if (!e) return h

    const ourNav = e.our_nav ? parseFloat(e.our_nav) : null
    const ourValue = ourNav ? ourNav * h.units : null
    const ourReturns = ourValue ? ourValue - h.investedValue : null

    return {
      ...h,
      schemeCode:     e.scheme_code ?? undefined,
      plan:           e.plan ?? h.schemeName.toLowerCase().includes('direct') ? 'Direct' : undefined,
      option:         e.option ?? undefined,
      schemeCategory: e.scheme_category ?? h.category,
      ourNav:         ourNav ?? undefined,
      ourValue:       ourValue ?? undefined,
      ourReturns:     ourReturns ?? undefined,
      navDate:        e.nav_date ?? undefined,
      matchedAs:      e.matched_as ?? undefined,
      enriched:       true,
    }
  })

  return { stocks: enrichedStocks, mf: enrichedMf }
}

export function buildSectorAllocation(stocks: StockHolding[]): AllocationSlice[] {
  const total = stocks.reduce((s, h) => s + h.closingValue, 0)
  if (total === 0) return []

  const bySector: Record<string, number> = {}
  for (const h of stocks) {
    const key = h.sector || h.industry || 'Unknown'
    bySector[key] = (bySector[key] || 0) + h.closingValue
  }

  return Object.entries(bySector)
    .sort(([, a], [, b]) => b - a)
    .map(([name, value], i) => ({
      name,
      value,
      percent: (value / total) * 100,
      color: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length],
    }))
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
