export interface StockHolding {
  stockName: string
  isin: string
  quantity: number
  avgBuyPrice: number
  buyValue: number
  closingPrice: number
  closingValue: number
  unrealisedPnL: number
  pnlPercent: number
  // enriched from DB
  symbol?: string
  sector?: string
  industry?: string
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
  currentValue: number
  returns: number
  xirr: string
  // enriched from DB
  schemeCode?: string
  plan?: string
  option?: string
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
