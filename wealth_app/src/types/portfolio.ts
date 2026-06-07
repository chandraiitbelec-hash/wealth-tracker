export interface StockHolding {
  stockName: string
  isin: string
  quantity: number
  avgBuyPrice: number
  buyValue: number
  closingPrice: number       // from Groww file
  closingValue: number
  unrealisedPnL: number
  pnlPercent: number
  // enriched from DB
  symbol?: string
  companyName?: string
  sector?: string
  industry?: string
  marketCapCategory?: string
  ourPrice?: number          // our latest price from daily_prices
  ourValue?: number          // quantity * ourPrice
  ourPnL?: number
  ourPnLPercent?: number
  priceDate?: string
  enriched?: boolean
}

export interface MFHolding {
  schemeName: string
  amc: string
  category: string
  subCategory: string
  folioNo: string
  source: string
  units: number
  investedValue: number
  currentValue: number       // from Groww file
  returns: number
  xirr: string
  // enriched from DB
  schemeCode?: string
  plan?: string
  option?: string
  schemeCategory?: string
  ourNav?: number            // our latest NAV from daily_prices
  ourValue?: number          // units * ourNav
  ourReturns?: number
  navDate?: string
  enriched?: boolean
  matchedAs?: string         // if fuzzy matched, the DB scheme name
}

export interface PortfolioSummary {
  // Stocks
  stocksInvested: number
  stocksCurrentValue: number
  stocksPnL: number
  stocksPnLPercent: number

  // Mutual Funds
  mfInvested: number
  mfCurrentValue: number
  mfReturns: number
  mfReturnsPercent: number

  // Combined
  totalInvested: number
  totalCurrentValue: number
  totalPnL: number
  totalPnLPercent: number

  // Counts
  stockCount: number
  mfCount: number
}

export interface AllocationSlice {
  name: string
  value: number
  percent: number
  color: string
}

export interface ParsedPortfolio {
  stocks: StockHolding[]
  mutualFunds: MFHolding[]
  summary: PortfolioSummary
  assetAllocation: AllocationSlice[]
  mfCategoryAllocation: AllocationSlice[]
  uploadedAt: string
  statementDate: string
}
