/**
 * Portfolio Insights Engine
 *
 * Computes structured insights from enriched portfolio data.
 * All computations are pure — no DB calls, no side effects.
 */

import { StockHolding, MFHolding, ParsedPortfolio } from '@/types/portfolio'
import { fmtCurrency, fmt } from './portfolio'

export type Severity = 'critical' | 'warning' | 'info' | 'positive'

export interface Insight {
  id: string
  severity: Severity
  title: string
  description: string
  detail?: string          // expanded text shown on click
  metric?: string          // key number shown on the card
  actionLabel?: string
  data?: any               // chart/table payload for rich rendering
}

export interface InsightsReport {
  healthScore: number       // 0–100
  healthLabel: string       // "Poor" | "Fair" | "Good" | "Excellent"
  scoreBreakdown: { label: string; score: number; max: number }[]
  insights: Insight[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function herfindahl(values: number[]): number {
  const total = values.reduce((s, v) => s + v, 0)
  if (total === 0) return 0
  return values.reduce((s, v) => s + Math.pow(v / total, 2), 0)
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

// ── Individual insight computers ─────────────────────────────────────────────

function concentrationRisk(
  stocks: StockHolding[],
  totalValue: number
): { insights: Insight[]; score: number } {
  const insights: Insight[] = []
  let score = 25 // max for this dimension

  const heavyStocks = stocks
    .filter(h => h.closingValue / totalValue > 0.10)
    .sort((a, b) => b.closingValue - a.closingValue)

  if (heavyStocks.length > 0) {
    const worst = heavyStocks[0]
    const pct = (worst.closingValue / totalValue) * 100
    const deduction = heavyStocks.length * 8
    score = Math.max(0, 25 - deduction)

    insights.push({
      id: 'concentration_risk',
      severity: pct > 20 ? 'critical' : 'warning',
      title: 'High single-stock concentration',
      description: `${heavyStocks.length} stock${heavyStocks.length > 1 ? 's exceed' : ' exceeds'} 10% of your total portfolio.`,
      metric: `${fmt(pct)}% in ${worst.symbol || worst.stockName}`,
      detail: `${heavyStocks.map(h => `${h.symbol || h.stockName}: ${fmt((h.closingValue / totalValue) * 100)}%`).join(' · ')}\n\nA single stock exceeding 10% of total portfolio creates outsized downside risk. Consider trimming to below 8–10%.`,
      data: heavyStocks.map(h => ({
        name: h.symbol || h.stockName,
        value: h.closingValue,
        percent: (h.closingValue / totalValue) * 100,
      })),
    })
  } else {
    insights.push({
      id: 'concentration_ok',
      severity: 'positive',
      title: 'No single-stock concentration risk',
      description: 'No individual stock exceeds 10% of your total portfolio.',
      metric: `${fmt(Math.max(...stocks.map(h => (h.closingValue / totalValue) * 100)))}% max`,
    })
  }

  return { insights, score }
}

function regularPlanDetector(mf: MFHolding[]): { insights: Insight[]; score: number } {
  const insights: Insight[] = []
  let score = 20

  const regularFunds = mf.filter(h => {
    const name = h.schemeName.toLowerCase()
    const plan = (h.plan || '').toLowerCase()
    return plan === 'regular' || (name.includes('regular') && !name.includes('direct'))
  })

  if (regularFunds.length > 0) {
    const totalRegularValue = regularFunds.reduce((s, h) => s + h.currentValue, 0)
    // Avg extra TER for regular vs direct ≈ 0.75–1.0%
    const estimatedAnnualExtraCost = totalRegularValue * 0.0075
    score = Math.max(0, 20 - regularFunds.length * 5)

    insights.push({
      id: 'regular_plans',
      severity: 'warning',
      title: 'Regular plan funds detected',
      description: `${regularFunds.length} of your MF${regularFunds.length > 1 ? 's are' : ' is a'} Regular plan, paying distributor commissions.`,
      metric: `~${fmtCurrency(estimatedAnnualExtraCost)}/yr extra cost`,
      detail: `Regular plans have an expense ratio ~0.75–1.0% higher than equivalent Direct plans. This compounds significantly over time.\n\nAffected funds:\n${regularFunds.map(h => `• ${h.schemeName}`).join('\n')}\n\nSwitch to Direct plans to save approximately ${fmtCurrency(estimatedAnnualExtraCost)} per year.`,
      actionLabel: 'Compare Direct plans',
      data: regularFunds.map(h => ({ name: h.schemeName, value: h.currentValue })),
    })
  } else {
    score = 20
    insights.push({
      id: 'all_direct',
      severity: 'positive',
      title: 'All MFs are Direct plans',
      description: 'You are not paying any distributor commission. Well done.',
      metric: '0 Regular plans',
    })
  }

  return { insights, score }
}

function assetAllocationHealth(
  stocks: StockHolding[],
  mf: MFHolding[],
  totalValue: number
): { insights: Insight[]; score: number } {
  const insights: Insight[] = []
  let score = 20

  const equityMfValue = mf
    .filter(h => (h.category || '').toLowerCase() === 'equity' || (h.schemeCategory || '').toLowerCase().includes('equity'))
    .reduce((s, h) => s + h.currentValue, 0)

  const debtValue = mf
    .filter(h => (h.category || '').toLowerCase() === 'debt' || (h.schemeCategory || '').toLowerCase().includes('debt'))
    .reduce((s, h) => s + h.currentValue, 0)

  const commodityValue = mf
    .filter(h => {
      const name = h.schemeName.toLowerCase()
      return name.includes('gold') || name.includes('silver')
    })
    .reduce((s, h) => s + h.currentValue, 0)
    + stocks
      .filter(h => {
        const name = h.stockName.toLowerCase()
        return name.includes('gold') || name.includes('silver')
      })
      .reduce((s, h) => s + h.closingValue, 0)

  const directEquityValue = stocks
    .filter(h => {
      const name = h.stockName.toLowerCase()
      return !name.includes('gold') && !name.includes('silver')
    })
    .reduce((s, h) => s + h.closingValue, 0)

  const totalEquity = directEquityValue + equityMfValue
  const equityPct = (totalEquity / totalValue) * 100
  const debtPct = (debtValue / totalValue) * 100
  const commodityPct = (commodityValue / totalValue) * 100

  const allocationData = [
    { name: 'Equity (Direct)', value: directEquityValue, percent: (directEquityValue / totalValue) * 100 },
    { name: 'Equity (MF)', value: equityMfValue, percent: (equityMfValue / totalValue) * 100 },
    { name: 'Debt', value: debtValue, percent: debtPct },
    { name: 'Commodities', value: commodityValue, percent: commodityPct },
  ].filter(d => d.value > 0)

  if (equityPct > 90) {
    score = 10
    insights.push({
      id: 'equity_heavy',
      severity: 'warning',
      title: 'Portfolio is heavily equity-concentrated',
      description: `${fmt(equityPct)}% of your portfolio is in equities with only ${fmt(debtPct)}% in debt instruments.`,
      metric: `${fmt(equityPct)}% equity`,
      detail: `High equity allocation is fine for long-term investors with high risk tolerance. However, having <10% in debt means no cushion during market corrections.\n\nConsider adding a liquid/short-duration debt fund as an emergency buffer (at least 10–15% of portfolio).`,
      data: allocationData,
    })
  } else if (debtPct === 0) {
    score = 12
    insights.push({
      id: 'no_debt',
      severity: 'warning',
      title: 'No debt allocation',
      description: 'Your portfolio has zero allocation to debt instruments.',
      metric: '0% debt',
      detail: 'Even aggressive investors benefit from 10–15% debt for liquidity and volatility buffering. Consider a liquid fund or overnight fund.',
      data: allocationData,
    })
  } else {
    score = 20
    insights.push({
      id: 'allocation_balanced',
      severity: 'info',
      title: 'Asset allocation',
      description: `Equity ${fmt(equityPct)}% · Debt ${fmt(debtPct)}% · Commodities ${fmt(commodityPct)}%`,
      metric: `${fmt(equityPct)}% equity`,
      data: allocationData,
    })
  }

  return { insights, score }
}

export interface ELSSFYData {
  financialYear: string
  elssInvestedInFY: number
  elssFunds: { schemeName: string; invested: number }[]
}

function elssAnalysis(
  mf: MFHolding[],
  fyData?: ELSSFYData | null
): { insights: Insight[]; score: number } {
  const insights: Insight[] = []

  const elssFunds = mf.filter(h =>
    (h.subCategory || '').toLowerCase() === 'elss' ||
    (h.schemeCategory || '').toLowerCase().includes('elss') ||
    h.schemeName.toLowerCase().includes('elss') ||
    h.schemeName.toLowerCase().includes('tax saver')
  )

  if (elssFunds.length === 0 && !fyData?.elssInvestedInFY) return { insights: [], score: 0 }

  const limit80C = 150000

  if (fyData) {
    // Accurate: based on actual FY transaction data
    const { financialYear, elssInvestedInFY, elssFunds: fyFunds } = fyData
    const eligible    = Math.min(elssInvestedInFY, limit80C)
    const taxSaving30 = eligible * 0.30
    const taxSaving20 = eligible * 0.20
    const remaining   = Math.max(0, limit80C - elssInvestedInFY)
    const totalElssValue = elssFunds.reduce((s, h) => s + h.currentValue, 0)
    const fundCount   = fyFunds.length

    insights.push({
      id: 'elss_summary',
      severity: fundCount > 3 ? 'warning' : 'info',
      title: `ELSS Tax Savings FY ${financialYear} — ${fundCount} fund${fundCount !== 1 ? 's' : ''}`,
      description: `${fmtCurrency(elssInvestedInFY)} invested in ELSS this financial year (FY ${financialYear}).`,
      metric: `Up to ${fmtCurrency(taxSaving30)} tax saved`,
      detail: [
        `📅 Based on your actual transactions for FY ${financialYear}`,
        ``,
        `80C eligible: ${fmtCurrency(eligible)} (limit ₹1.5L)`,
        remaining > 0 ? `Room remaining: ${fmtCurrency(remaining)} — invest before Mar 31 to maximise deduction` : `✅ 80C limit fully utilised`,
        ``,
        `Estimated tax saving:`,
        `• 30% bracket: ${fmtCurrency(taxSaving30)}`,
        `• 20% bracket: ${fmtCurrency(taxSaving20)}`,
        ``,
        `Current ELSS portfolio value: ${fmtCurrency(totalElssValue)}`,
        ``,
        fundCount > 3 ? `⚠️ You hold more than 3 ELSS funds — most overlap significantly. Consider consolidating to 1–2 funds.` : '',
      ].filter(Boolean).join('\n'),
      data: fyFunds.map(f => ({ name: f.schemeName, invested: f.invested })),
    })
  } else {
    // Estimate: based on total invested value in holdings (may include multiple years)
    const totalElssInvested = elssFunds.reduce((s, h) => s + h.investedValue, 0)
    const totalElssValue    = elssFunds.reduce((s, h) => s + h.currentValue, 0)
    const eligible    = Math.min(totalElssInvested, limit80C)
    const taxSaving30 = eligible * 0.30
    const taxSaving20 = eligible * 0.20

    // Without a transaction file we only know total invested across all years,
    // not what was invested in the current FY. Show the card as a prompt to
    // upload rather than a confident tax-saving figure.
    insights.push({
      id: 'elss_summary',
      severity: 'warning',   // always warn — number is unreliable without file
      title: `ELSS Tax Savings — ${elssFunds.length} fund${elssFunds.length !== 1 ? 's' : ''}`,
      description: `You hold ${elssFunds.length} ELSS fund${elssFunds.length !== 1 ? 's' : ''}, but we can't calculate your current-FY 80C benefit without your transaction statement.`,
      metric: `Upload MF statement for accurate figure`,
      detail: [
        `⚠️ We only see your total invested value (${fmtCurrency(totalElssInvested)} across all years), not what you invested in the current financial year.`,
        `80C deductions apply only to investments made in the current FY — previous years don't count again.`,
        ``,
        `To get an accurate figure, upload your MF transaction statement:`,
        `Groww → Statements → Mutual Fund Order History`,
        `Zerodha → Console → Reports → P&L → Tradebook`,
        ``,
        `Once uploaded, we'll show your exact FY investment, remaining 80C room, and tax saving.`,
        ``,
        elssFunds.length > 3 ? `⚠️ You hold more than 3 ELSS funds — most overlap significantly. Consider consolidating to 1–2 funds.` : '',
      ].filter(Boolean).join('\n'),
      data: elssFunds.map(h => ({ name: h.schemeName, invested: h.investedValue, current: h.currentValue })),
    })
  }

  return { insights, score: 0 }  // ELSS is informational, not scored
}

function diversificationScore(
  stocks: StockHolding[],
  mf: MFHolding[]
): { insights: Insight[]; score: number } {
  const insights: Insight[] = []

  const stockValues = stocks.map(h => h.closingValue)
  const mfValues    = mf.map(h => h.currentValue)
  const allValues   = [...stockValues, ...mfValues]

  const hhi = herfindahl(allValues)  // 0 = perfect diversification, 1 = one holding

  // Convert to a 0–15 score (15 = well diversified)
  // HHI < 0.10 = good, 0.10–0.25 = moderate, > 0.25 = concentrated
  let score = 15
  if (hhi > 0.25) score = 5
  else if (hhi > 0.15) score = 10
  else if (hhi > 0.10) score = 12

  const label = hhi < 0.10 ? 'Well diversified' : hhi < 0.20 ? 'Moderately concentrated' : 'Highly concentrated'
  const effectiveN = Math.round(1 / hhi)  // "equivalent" number of equal-weight holdings

  insights.push({
    id: 'diversification',
    severity: hhi > 0.25 ? 'warning' : hhi > 0.15 ? 'info' : 'positive',
    title: label,
    description: `Your portfolio behaves like ${effectiveN} equally-weighted holdings.`,
    metric: `${stocks.length + mf.length} total positions`,
    detail: `Herfindahl Index: ${fmt(hhi, 3)} (lower = more diversified)\n\nYou have ${stocks.length} direct stock${stocks.length !== 1 ? 's' : ''} and ${mf.length} MF scheme${mf.length !== 1 ? 's' : ''}, equivalent in concentration to ${effectiveN} equal-weight holdings.\n\nHHI < 0.10 is considered well diversified.`,
  })

  return { insights, score }
}

function sectorConcentration(stocks: StockHolding[], totalValue: number): Insight[] {
  const insights: Insight[] = []
  if (stocks.length === 0) return insights

  // Only run if we have sector data for at least half the stocks
  const enrichedStocks = stocks.filter(h => h.sector && h.sector !== 'Unknown')
  if (enrichedStocks.length < stocks.length / 2) return insights

  // Aggregate by sector
  const sectorMap: Record<string, number> = {}
  for (const h of stocks) {
    const sector = h.sector || 'Unknown'
    sectorMap[sector] = (sectorMap[sector] || 0) + h.closingValue
  }

  const sectorData = Object.entries(sectorMap)
    .map(([name, value]) => ({ name, value, percent: (value / totalValue) * 100 }))
    .sort((a, b) => b.value - a.value)

  const heavySectors = sectorData.filter(s => s.name !== 'Unknown' && s.percent > 25)

  if (heavySectors.length > 0) {
    const top = heavySectors[0]
    insights.push({
      id: 'sector_concentration',
      severity: top.percent > 40 ? 'warning' : 'info',
      title: 'Sector concentration in direct equity',
      description: `${top.name} makes up ${fmt(top.percent)}% of your total portfolio.`,
      metric: `${fmt(top.percent)}% in ${top.name}`,
      detail: `Your direct equity sector breakdown:\n${sectorData.filter(s => s.name !== 'Unknown').map(s => `• ${s.name}: ${fmt(s.percent)}%`).join('\n')}\n\nA single sector exceeding 25% of total portfolio increases correlation risk. Consider spreading across more sectors.`,
      data: sectorData,
    })
  } else {
    insights.push({
      id: 'sector_balanced',
      severity: 'positive',
      title: 'Sector exposure is balanced',
      description: `No single sector exceeds 25% of your portfolio.`,
      metric: `${sectorData.length} sectors`,
      detail: `Your direct equity sector breakdown:\n${sectorData.filter(s => s.name !== 'Unknown').map(s => `• ${s.name}: ${fmt(s.percent)}%`).join('\n')}`,
      data: sectorData,
    })
  }

  return insights
}

// Keywords that indicate bonds/NCDs/debentures — excluded from stock P&L analysis
const BOND_KEYWORDS = ['NCD', 'BOND', 'DEBENTURE', 'TBILL', 'GSEC', 'SDL', 'TREPS']

function isBondLike(h: StockHolding): boolean {
  const name = ((h.symbol || '') + ' ' + (h.stockName || '')).toUpperCase()
  return BOND_KEYWORDS.some(k => name.includes(k))
}

function pnlInsights(stocks: StockHolding[]): Insight[] {
  const insights: Insight[] = []
  if (stocks.length === 0) return insights

  // Exclude bonds/NCDs — their "P&L" isn't comparable to equities
  const equities = stocks.filter(h => !isBondLike(h))
  if (equities.length === 0) return insights

  // Only include holdings with a meaningful return (>-99% avoids data artifacts)
  const sorted = [...equities]
    .filter(h => h.pnlPercent > -99)
    .sort((a, b) => b.pnlPercent - a.pnlPercent)

  const topGainers = sorted.slice(0, 3).filter(h => h.pnlPercent > 0)
  const topLosers  = sorted.slice(-3).reverse().filter(h => h.pnlPercent < 0)

  if (topGainers.length > 0) {
    insights.push({
      id: 'top_gainers',
      severity: 'positive',
      title: 'Top performers',
      description: topGainers.map(h => `${h.symbol || h.stockName} +${fmt(h.pnlPercent)}%`).join(' · '),
      metric: `+${fmt(topGainers[0].pnlPercent)}%`,
      data: topGainers,
    })
  }

  if (topLosers.length > 0) {
    // Use average return as headline metric rather than worst single holding
    const avgLoss = topLosers.reduce((s, h) => s + h.pnlPercent, 0) / topLosers.length
    insights.push({
      id: 'top_losers',
      severity: topLosers[0].pnlPercent < -20 ? 'warning' : 'info',
      title: 'Underperformers',
      description: topLosers.map(h => `${h.symbol || h.stockName} ${fmt(h.pnlPercent)}%`).join(' · '),
      metric: `${fmt(avgLoss)}% avg`,
      data: topLosers,
    })
  }

  return insights
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeInsights(
  portfolio: ParsedPortfolio,
  fyData?: ELSSFYData | null
): InsightsReport {
  const { stocks, mutualFunds: mf, summary } = portfolio
  const totalValue = summary.totalCurrentValue

  if (totalValue === 0) {
    return { healthScore: 0, healthLabel: 'No data', scoreBreakdown: [], insights: [] }
  }

  const concResult  = concentrationRisk(stocks, totalValue)
  const planResult  = regularPlanDetector(mf)
  const allocResult = assetAllocationHealth(stocks, mf, totalValue)
  const divResult   = diversificationScore(stocks, mf)
  const elssResult  = elssAnalysis(mf, fyData)

  const scoreBreakdown = [
    { label: 'Concentration',    score: concResult.score,  max: 25 },
    { label: 'Regular plans',    score: planResult.score,  max: 20 },
    { label: 'Asset allocation', score: allocResult.score, max: 20 },
    { label: 'Diversification',  score: divResult.score,   max: 15 },
    { label: 'Profitability',    score: 20,                max: 20 }, // base points
  ]

  const healthScore = clamp(scoreBreakdown.reduce((s, d) => s + d.score, 0), 0, 100)
  const healthLabel =
    healthScore >= 80 ? 'Excellent' :
    healthScore >= 60 ? 'Good' :
    healthScore >= 40 ? 'Fair' : 'Needs attention'

  const allInsights: Insight[] = [
    ...concResult.insights,
    ...planResult.insights,
    ...allocResult.insights,
    ...divResult.insights,
    ...elssResult.insights,
    ...sectorConcentration(stocks, totalValue),
    ...pnlInsights(stocks),
  ]

  // Sort: critical → warning → info → positive
  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, positive: 3 }
  allInsights.sort((a, b) => order[a.severity] - order[b.severity])

  return { healthScore, healthLabel, scoreBreakdown, insights: allInsights }
}
