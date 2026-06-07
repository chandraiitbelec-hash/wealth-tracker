'use client'

import { PortfolioSummary } from '@/types/portfolio'
import { fmtCurrency, fmt } from '@/lib/portfolio'
import { TrendingUp, TrendingDown, BarChart3, PieChart } from 'lucide-react'

interface CardProps {
  title: string
  value: string
  sub: string
  pnl?: number
  pnlPercent?: number
  icon: React.ReactNode
  accent: string
}

function Card({ title, value, sub, pnl, pnlPercent, icon, accent }: CardProps) {
  const isPositive = (pnl ?? 0) >= 0
  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{title}</span>
        <div className={`p-2 rounded-xl ${accent}`}>{icon}</div>
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        <p className="text-xs text-gray-400 mt-0.5">{sub}</p>
      </div>
      {pnl !== undefined && (
        <div className={`flex items-center gap-1.5 text-sm font-semibold ${isPositive ? 'text-green-600' : 'text-red-500'}`}>
          {isPositive ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
          {isPositive ? '+' : ''}{fmtCurrency(pnl)}
          <span className="font-normal text-xs opacity-80">
            ({isPositive ? '+' : ''}{fmt(pnlPercent ?? 0)}%)
          </span>
        </div>
      )}
    </div>
  )
}

export default function SummaryCards({ summary }: { summary: PortfolioSummary }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <Card
        title="Total Portfolio"
        value={fmtCurrency(summary.totalCurrentValue)}
        sub={`Invested: ${fmtCurrency(summary.totalInvested)}`}
        pnl={summary.totalPnL}
        pnlPercent={summary.totalPnLPercent}
        icon={<PieChart className="w-4 h-4 text-indigo-600" />}
        accent="bg-indigo-50"
      />
      <Card
        title="Direct Equity"
        value={fmtCurrency(summary.stocksCurrentValue)}
        sub={`${summary.stockCount} stocks · Invested: ${fmtCurrency(summary.stocksInvested)}`}
        pnl={summary.stocksPnL}
        pnlPercent={summary.stocksPnLPercent}
        icon={<BarChart3 className="w-4 h-4 text-violet-600" />}
        accent="bg-violet-50"
      />
      <Card
        title="Mutual Funds"
        value={fmtCurrency(summary.mfCurrentValue)}
        sub={`${summary.mfCount} schemes · Invested: ${fmtCurrency(summary.mfInvested)}`}
        pnl={summary.mfReturns}
        pnlPercent={summary.mfReturnsPercent}
        icon={<TrendingUp className="w-4 h-4 text-emerald-600" />}
        accent="bg-emerald-50"
      />
      <Card
        title="Overall Gain"
        value={`${summary.totalPnLPercent >= 0 ? '+' : ''}${fmt(summary.totalPnLPercent)}%`}
        sub={`Absolute return on ${fmtCurrency(summary.totalInvested)}`}
        pnl={summary.totalPnL}
        pnlPercent={summary.totalPnLPercent}
        icon={<TrendingUp className="w-4 h-4 text-amber-600" />}
        accent="bg-amber-50"
      />
    </div>
  )
}
