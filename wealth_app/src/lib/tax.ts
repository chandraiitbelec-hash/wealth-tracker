/**
 * Tax Optimizer — STCG / LTCG for Indian equities
 *
 * Rules (post-Budget 2024, effective FY 2024-25):
 *   Equity stocks & equity-oriented MFs
 *     · STCG (held < 12 months) : 20% flat
 *     · LTCG (held ≥ 12 months) : first ₹1,25,000 per FY is tax-free, excess at 12.5%
 *
 * Lot matching: FIFO — oldest BUY lots are consumed by SELL orders first.
 * Remaining lots represent the current open position.
 */

import { StockOrder } from './parsers/stock-orders'
import { StockHolding } from '@/types/portfolio'

// ── Tax rate constants (post-Budget 2024, FY 2024-25) ────────────────────────
// Update these if the Finance Act changes the rates.

/** Annual LTCG exemption — first ₹1,25,000 of long-term gains is tax-free per FY. */
const LTCG_EXEMPTION = 125_000

/** Short-term capital gains tax rate: flat 20% on equity (held < 12 months). */
const STCG_RATE      = 0.20

/** Long-term capital gains tax rate: 12.5% on equity gains above LTCG_EXEMPTION. */
const LTCG_RATE      = 0.125

// ── Interfaces ────────────────────────────────────────────────────────────────

/** A single open tax lot — one BUY fill, possibly partially consumed by SELLs. */
export interface TaxLot {
  symbol: string
  stockName: string
  buyDate: string          // YYYY-MM-DD
  quantity: number
  buyPrice: number         // per share
  costBasis: number        // quantity × buyPrice
  holdingDays: number      // as of today
  isLTCG: boolean          // holdingDays >= 365
  currentPrice: number | null
  currentValue: number | null
  gain: number | null      // currentValue - costBasis
  gainPct: number | null
}

/** Aggregated tax position for a single NSE symbol — all lots combined. */
export interface SymbolTaxSummary {
  symbol: string
  stockName: string
  currentHolding: number   // shares per portfolio file
  matchedLots: number      // shares we have lot data for
  lots: TaxLot[]
  stcgQty: number
  ltcgQty: number
  stcgGain: number
  ltcgGain: number
  estimatedSTCGTax: number // at 20%
  estimatedLTCGTax: number // at 12.5% on gain above ₹1.25L threshold
}

/** Portfolio-level tax report — aggregated across all symbols. */
export interface TaxReport {
  bySymbol: SymbolTaxSummary[]
  totalSTCGGain: number
  totalLTCGGain: number
  // LTCG tax: apply ₹1.25L annual exemption first
  ltcgExemption: number     // = min(totalLTCGGain, 125000)
  taxableLTCG: number
  estimatedSTCGTax: number  // 20% of totalSTCGGain
  estimatedLTCGTax: number  // 12.5% of taxableLTCG
  totalEstimatedTax: number
}

/** A single recommended lot to sell as part of a tax-optimised sell plan. */
export interface SellRecommendation {
  symbol: string
  stockName: string
  lotDate: string
  quantity: number
  buyPrice: number
  currentPrice: number
  isLTCG: boolean
  gain: number
  taxOnGain: number
  proceeds: number
}

/** A complete tax-optimised sell plan for a target proceeds amount. */
export interface SellPlan {
  targetAmount: number
  recommendations: SellRecommendation[]
  totalProceeds: number
  totalTax: number
  totalGain: number
  ltcgUsed: number          // how much of ₹1.25L exemption consumed
  ltcgRemaining: number     // remaining exemption after this sale
}

// ── Core: build open lots from order history ─────────────────────────────────

// Memoised sort cache: keyed by a stable fingerprint of the buy order list.
// `buildTaxReport` is called on every slider tick in the sell simulator, but
// the underlying order history never changes within a session. Sorting O(n log n)
// on every call is wasteful — sort once and cache the result.
const _sortedBuyCache = new Map<string, StockOrder[]>()

function _sortedBuys(buys: StockOrder[]): StockOrder[] {
  // Fingerprint: join order IDs (or date+price as a proxy if no ID)
  const key = buys.map(b => `${b.date}|${b.price}|${b.quantity}`).join(',')
  if (!_sortedBuyCache.has(key)) {
    _sortedBuyCache.set(key, [...buys].sort((a, b) => a.date.localeCompare(b.date)))
  }
  return _sortedBuyCache.get(key)!
}

/**
 * Given all BUY/SELL orders for a symbol (sorted by date),
 * returns the remaining open lots using FIFO matching.
 */
function computeOpenLots(
  buys: StockOrder[],
  sells: StockOrder[],
  currentQty: number
): Array<{ date: string; qty: number; price: number }> {
  // Use cached sort for buys; sells are typically few so sort inline
  const sortedBuys  = _sortedBuys(buys)
  const sortedSells = [...sells].sort((a, b) => a.date.localeCompare(b.date))

  // Lot queue (FIFO)
  const lots: Array<{ date: string; qty: number; price: number }> = sortedBuys.map(b => ({
    date:  b.date,
    qty:   b.quantity,
    price: b.price,
  }))

  // Consume sell quantities from oldest lots first
  for (const sell of sortedSells) {
    let remaining = sell.quantity
    for (const lot of lots) {
      if (remaining <= 0) break
      const consumed = Math.min(lot.qty, remaining)
      lot.qty -= consumed
      remaining -= consumed
    }
  }

  // What's left
  const open = lots.filter(l => l.qty > 0)

  // Safety: cap to current portfolio quantity if it's less than what lots say
  // (happens when old orders pre-date the upload window)
  let capRemaining = currentQty
  const capped: typeof open = []
  for (const lot of open) {
    if (capRemaining <= 0) break
    const take = Math.min(lot.qty, capRemaining)
    capped.push({ ...lot, qty: take })
    capRemaining -= take
  }
  return capped
}

// ── Days since buy date ───────────────────────────────────────────────────────

function daysSince(dateStr: string): number {
  const buy  = new Date(dateStr)
  const now  = new Date()
  return Math.floor((now.getTime() - buy.getTime()) / 86_400_000)
}

// ── Main analysis ─────────────────────────────────────────────────────────────

export function buildTaxReport(
  orders: StockOrder[],
  holdings: StockHolding[],
  ltcgAlreadyUsed = 0   // pass if user has realised LTCG elsewhere this FY
): TaxReport {
  const bySymbol: SymbolTaxSummary[] = []

  // Group orders by symbol
  const ordersBySymbol: Record<string, StockOrder[]> = {}
  for (const o of orders) {
    const key = o.symbol || o.isin
    if (!ordersBySymbol[key]) ordersBySymbol[key] = []
    ordersBySymbol[key].push(o)
  }

  // Build a quick lookup from portfolio holdings
  const holdingBySymbol: Record<string, StockHolding> = {}
  for (const h of holdings) {
    if (h.symbol) holdingBySymbol[h.symbol] = h
    if (h.isin)   holdingBySymbol[h.isin]   = h
  }

  for (const [sym, symOrders] of Object.entries(ordersBySymbol)) {
    const holding = holdingBySymbol[sym]
    if (!holding) continue   // no current holding for this symbol

    const buys  = symOrders.filter(o => o.type === 'BUY')
    const sells = symOrders.filter(o => o.type === 'SELL')
    const currentQty = holding.quantity

    const openLots = computeOpenLots(buys, sells, currentQty)
    if (openLots.length === 0) continue

    const currentPrice = holding.closingPrice ?? holding.ourPrice ?? null

    const lots: TaxLot[] = openLots.map(lot => {
      const days       = daysSince(lot.date)
      const isLTCG     = days >= 365
      const costBasis  = lot.qty * lot.price
      const currentVal = currentPrice !== null ? lot.qty * currentPrice : null
      const gain       = currentVal !== null ? currentVal - costBasis : null
      return {
        symbol:       sym,
        stockName:    holding.companyName || holding.stockName,
        buyDate:      lot.date,
        quantity:     lot.qty,
        buyPrice:     lot.price,
        costBasis,
        holdingDays:  days,
        isLTCG,
        currentPrice,
        currentValue: currentVal,
        gain,
        gainPct:      gain !== null && costBasis > 0 ? (gain / costBasis) * 100 : null,
      }
    })

    const stcgLots = lots.filter(l => !l.isLTCG)
    const ltcgLots = lots.filter(l => l.isLTCG)

    const stcgQty  = stcgLots.reduce((s, l) => s + l.quantity, 0)
    const ltcgQty  = ltcgLots.reduce((s, l) => s + l.quantity, 0)
    const stcgGain = stcgLots.reduce((s, l) => s + (l.gain ?? 0), 0)
    const ltcgGain = ltcgLots.reduce((s, l) => s + (l.gain ?? 0), 0)

    bySymbol.push({
      symbol:      sym,
      stockName:   holding.companyName || holding.stockName,
      currentHolding: currentQty,
      matchedLots: openLots.reduce((s, l) => s + l.qty, 0),
      lots,
      stcgQty,
      ltcgQty,
      stcgGain,
      ltcgGain,
      estimatedSTCGTax: stcgGain > 0 ? stcgGain * STCG_RATE : 0,
      estimatedLTCGTax: 0, // computed at portfolio level below
    })
  }

  const totalSTCGGain = bySymbol.reduce((s, r) => s + r.stcgGain, 0)
  const totalLTCGGain = bySymbol.reduce((s, r) => s + r.ltcgGain, 0)
  const availableExemption = Math.max(0, LTCG_EXEMPTION - ltcgAlreadyUsed)
  const ltcgExemption   = Math.min(Math.max(0, totalLTCGGain), availableExemption)
  const taxableLTCG     = Math.max(0, totalLTCGGain - ltcgExemption)
  const estimatedSTCGTax = Math.max(0, totalSTCGGain) * STCG_RATE
  const estimatedLTCGTax = taxableLTCG * LTCG_RATE

  return {
    bySymbol,
    totalSTCGGain,
    totalLTCGGain,
    ltcgExemption,
    taxableLTCG,
    estimatedSTCGTax,
    estimatedLTCGTax,
    totalEstimatedTax: estimatedSTCGTax + estimatedLTCGTax,
  }
}

// ── Sell simulator ────────────────────────────────────────────────────────────

/**
 * Given a target sell amount (₹), recommend the optimal lots to sell
 * to minimise tax. Strategy:
 *   1. Fill from LTCG lots within remaining ₹1.25L exemption (0% tax)
 *   2. Then LTCG lots above exemption (12.5%)
 *   3. Finally STCG lots (20%)
 */
export function buildSellPlan(
  report: TaxReport,
  targetAmount: number,
  ltcgAlreadyUsed = 0
): SellPlan {
  // Flatten all lots that have a current price, sorted for tax efficiency
  const allLots: Array<TaxLot & { symbol: string }> = []
  for (const sym of report.bySymbol) {
    for (const lot of sym.lots) {
      if (lot.currentPrice !== null && lot.gain !== null) {
        allLots.push({ ...lot, symbol: sym.symbol })
      }
    }
  }

  // Sort: LTCG lots with smallest gain first (maximises tax-free use), then STCG last
  const ltcgLots = allLots.filter(l => l.isLTCG).sort((a, b) => (a.gain ?? 0) - (b.gain ?? 0))
  const stcgLots = allLots.filter(l => !l.isLTCG).sort((a, b) => (a.gain ?? 0) - (b.gain ?? 0))
  const ordered  = [...ltcgLots, ...stcgLots]

  let availableExemption = Math.max(0, LTCG_EXEMPTION - ltcgAlreadyUsed)
  let remaining   = targetAmount
  let totalTax    = 0
  let totalGain   = 0
  let ltcgUsed    = 0
  const recs: SellRecommendation[] = []

  for (const lot of ordered) {
    if (remaining <= 0) break
    if (!lot.currentPrice) continue

    // How many shares can we take from this lot?
    const maxProceeds = lot.quantity * lot.currentPrice
    const take        = remaining >= maxProceeds ? lot.quantity : Math.floor(remaining / lot.currentPrice)
    if (take <= 0) continue

    const proceeds  = take * lot.currentPrice
    const costBasis = take * lot.buyPrice
    const gain      = proceeds - costBasis

    let taxOnGain = 0
    if (lot.isLTCG) {
      const exempt   = Math.min(Math.max(0, gain), availableExemption)
      const taxable  = Math.max(0, gain - exempt)
      taxOnGain      = taxable * LTCG_RATE
      availableExemption -= exempt
      ltcgUsed       += exempt
    } else {
      taxOnGain = gain > 0 ? gain * STCG_RATE : 0
    }

    recs.push({
      symbol:       lot.symbol,
      stockName:    lot.stockName,
      lotDate:      lot.buyDate,
      quantity:     take,
      buyPrice:     lot.buyPrice,
      currentPrice: lot.currentPrice,
      isLTCG:       lot.isLTCG,
      gain,
      taxOnGain,
      proceeds,
    })

    totalGain  += gain
    totalTax   += taxOnGain
    remaining  -= proceeds
  }

  return {
    targetAmount,
    recommendations: recs,
    totalProceeds: recs.reduce((s, r) => s + r.proceeds, 0),
    totalTax,
    totalGain,
    ltcgUsed,
    ltcgRemaining: Math.max(0, LTCG_EXEMPTION - ltcgAlreadyUsed - ltcgUsed),
  }
}
