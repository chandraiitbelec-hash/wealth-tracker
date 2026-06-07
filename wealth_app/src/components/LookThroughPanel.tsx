'use client'

import { useEffect, useState } from 'react'
import { fmtCurrency, fmt } from '@/lib/portfolio'
import { StockHolding, MFHolding } from '@/types/portfolio'
import { TrendingUp, AlertTriangle, Info, ChevronDown, ChevronUp, Layers } from 'lucide-react'

interface ConsolidatedHolding {
  isin: string
  name: string
  industry: string | null
  directValue: number
  indirectValue: number
  totalValue: number
  portfolioPct: number
  throughFunds: { fundName: string; exposure: number }[]
  isDirectHolding: boolean
}

interface LookThroughResult {
  consolidatedHoldings: ConsolidatedHolding[]
  coverageRatio: number
  latestDisclosureDate: string | null
  totalPortfolioValue: number
}

interface Props {
  stocks: StockHolding[]
  mf: MFHolding[]
}

// ── Exposure bar ──────────────────────────────────────────────────────────────

function ExposureBar({ direct, indirect, total }: { direct: number; indirect: number; total: number }) {
  const directPct   = total > 0 ? (direct   / total) * 100 : 0
  const indirectPct = total > 0 ? (indirect / total) * 100 : 0
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden bg-gray-100 w-full">
      {direct > 0 && (
        <div className="h-full bg-violet-500" style={{ width: `${directPct}%` }} title={`Direct: ${fmtCurrency(direct)}`} />
      )}
      {indirect > 0 && (
        <div className="h-full bg-indigo-300" style={{ width: `${indirectPct}%` }} title={`Via MFs: ${fmtCurrency(indirect)}`} />
      )}
    </div>
  )
}

// ── Holding row ───────────────────────────────────────────────────────────────

function HoldingRow({
  h,
  rank,
  totalPortfolio,
}: {
  h: ConsolidatedHolding
  rank: number
  totalPortfolio: number
}) {
  const [open, setOpen] = useState(false)
  const isConcentrated = h.portfolioPct >= 10

  return (
    <div className={`bg-white rounded-2xl border shadow-sm overflow-hidden ${isConcentrated ? 'border-amber-200' : 'border-gray-100'}`}>
      <button
        className="w-full text-left px-5 py-4 flex items-center gap-3 hover:bg-gray-50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {/* Rank */}
        <span className="text-xs font-bold text-gray-400 w-5 shrink-0">{rank}</span>

        {/* Name + chips */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm text-gray-900 truncate">{h.name}</p>
            {h.isDirectHolding && (
              <span className="text-xs bg-violet-50 text-violet-700 px-2 py-0.5 rounded-full font-medium shrink-0">
                Direct
              </span>
            )}
            {h.throughFunds.length > 0 && (
              <span className="text-xs bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-medium shrink-0">
                +{h.throughFunds.length} fund{h.throughFunds.length > 1 ? 's' : ''}
              </span>
            )}
            {isConcentrated && (
              <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full font-medium shrink-0 flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" />Concentrated
              </span>
            )}
          </div>
          {h.industry && <p className="text-xs text-gray-400 mt-0.5">{h.industry}</p>}
          <div className="mt-1.5">
            <ExposureBar direct={h.directValue} indirect={h.indirectValue} total={h.totalValue} />
          </div>
        </div>

        {/* Value + pct */}
        <div className="text-right shrink-0">
          <p className="text-sm font-bold text-gray-900">{fmtCurrency(h.totalValue)}</p>
          <p className={`text-xs font-semibold ${isConcentrated ? 'text-amber-600' : 'text-gray-400'}`}>
            {fmt(h.portfolioPct, 2)}% of portfolio
          </p>
        </div>

        {open ? <ChevronUp className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />}
      </button>

      {open && (
        <div className="px-5 pb-4 border-t border-gray-50">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3 text-xs">
            <div className="bg-violet-50 rounded-xl px-3 py-2.5">
              <p className="text-violet-500 mb-0.5">Direct holding</p>
              <p className="font-bold text-violet-800">{fmtCurrency(h.directValue)}</p>
            </div>
            <div className="bg-indigo-50 rounded-xl px-3 py-2.5">
              <p className="text-indigo-500 mb-0.5">Via mutual funds</p>
              <p className="font-bold text-indigo-800">{fmtCurrency(h.indirectValue)}</p>
            </div>
            <div className="bg-gray-50 rounded-xl px-3 py-2.5">
              <p className="text-gray-400 mb-0.5">True total exposure</p>
              <p className="font-bold text-gray-900">{fmtCurrency(h.totalValue)}</p>
            </div>
          </div>

          {h.throughFunds.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-gray-400 mb-2">MF exposure breakdown</p>
              <div className="space-y-1.5">
                {h.throughFunds
                  .sort((a, b) => b.exposure - a.exposure)
                  .map((f, i) => (
                    <div key={i} className="flex justify-between text-xs bg-gray-50 rounded-lg px-3 py-2">
                      <span className="text-gray-600 truncate mr-2">{f.fundName}</span>
                      <span className="font-medium text-gray-800 shrink-0">{fmtCurrency(f.exposure)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Concentration alert ───────────────────────────────────────────────────────

function ConcentrationAlert({ holdings }: { holdings: ConsolidatedHolding[] }) {
  const concentrated = holdings.filter(h => h.portfolioPct >= 10)
  if (concentrated.length === 0) return null

  return (
    <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
      <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
      <div>
        <p className="text-sm font-semibold text-amber-800">
          {concentrated.length} high-concentration position{concentrated.length > 1 ? 's' : ''} detected
        </p>
        <p className="text-xs text-amber-600 mt-0.5">
          {concentrated.map(h => `${h.name} (${fmt(h.portfolioPct, 1)}%)`).join(' · ')} —
          {' '}including exposure through mutual funds. Consider rebalancing.
        </p>
      </div>
    </div>
  )
}

// ── No data state ─────────────────────────────────────────────────────────────

function NoCoverageState({ coverageRatio }: { coverageRatio: number }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
      <div className="flex justify-center mb-4">
        <div className="p-4 bg-indigo-50 rounded-2xl">
          <Layers className="w-10 h-10 text-indigo-400" />
        </div>
      </div>
      <p className="font-semibold text-gray-700 mb-2">Portfolio disclosure data not yet loaded</p>
      <p className="text-sm text-gray-400 max-w-md mx-auto">
        The AMFI portfolio scraper needs to run first to populate fund holdings.
        Run <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">python ingestion/amfi_portfolio.py</code> in
        your pipeline, or wait for the monthly scheduled job (15th of each month).
      </p>
      {coverageRatio > 0 && (
        <p className="text-xs text-indigo-500 mt-3">
          Partial data available — {fmt(coverageRatio * 100, 0)}% of MF value has portfolio data.
        </p>
      )}
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function LookThroughPanel({ stocks, mf }: Props) {
  const [result, setResult]   = useState<LookThroughResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    if (!stocks.length && !mf.length) { setLoading(false); return }

    fetch('/api/lookahead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stocks, mf }),
    })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setResult(d) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])   // compute once on mount

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
    </div>
  )

  if (error) return (
    <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-sm text-red-600">{error}</div>
  )

  if (!result) return null

  const { consolidatedHoldings: holdings, coverageRatio, latestDisclosureDate, totalPortfolioValue } = result

  // Split: holdings only visible through MFs vs direct+indirect
  const overlappingHoldings = holdings.filter(h => h.isDirectHolding && h.indirectValue > 0)
  const hasData = holdings.length > 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-semibold text-gray-800">True Consolidated Exposure</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Your direct equity + stocks held indirectly through mutual funds — combined into one view.
          </p>
        </div>
        {latestDisclosureDate && (
          <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-lg shrink-0">
            Portfolio data: {new Date(latestDisclosureDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
          </span>
        )}
      </div>

      {/* Coverage notice */}
      {coverageRatio < 1 && coverageRatio > 0 && (
        <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-2xl px-4 py-3 text-xs text-blue-700">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Portfolio disclosure data covers <strong>{fmt(coverageRatio * 100, 0)}%</strong> of your MF value.
            Some funds may not yet have their latest monthly disclosures ingested.
          </span>
        </div>
      )}

      {/* Overlap callout */}
      {overlappingHoldings.length > 0 && (
        <div className="flex items-start gap-3 bg-violet-50 border border-violet-100 rounded-2xl px-4 py-3">
          <TrendingUp className="w-4 h-4 text-violet-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-violet-800">
              {overlappingHoldings.length} overlap{overlappingHoldings.length > 1 ? 's' : ''} found between your direct stocks and MF holdings
            </p>
            <p className="text-xs text-violet-600 mt-0.5">
              {overlappingHoldings.map(h => h.name).join(', ')} —
              {' '}you hold these directly <em>and</em> through funds, increasing actual concentration.
            </p>
          </div>
        </div>
      )}

      {/* Concentration alerts */}
      {hasData && <ConcentrationAlert holdings={holdings} />}

      {/* Legend */}
      {hasData && (
        <div className="flex items-center gap-5 text-xs text-gray-500">
          <span className="flex items-center gap-1.5"><span className="w-3 h-1.5 bg-violet-500 rounded-full inline-block" />Direct equity</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-1.5 bg-indigo-300 rounded-full inline-block" />Via mutual funds</span>
        </div>
      )}

      {/* Holdings list or no-data state */}
      {!hasData ? (
        <NoCoverageState coverageRatio={coverageRatio} />
      ) : (
        <div className="space-y-3">
          {holdings.slice(0, 50).map((h, i) => (
            <HoldingRow key={h.isin} h={h} rank={i + 1} totalPortfolio={totalPortfolioValue} />
          ))}
          {holdings.length > 50 && (
            <p className="text-xs text-gray-400 text-center py-2">
              Showing top 50 of {holdings.length} positions
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-gray-400 text-center">
        MF exposure computed from AMFI monthly portfolio disclosures · Updated monthly
      </p>
    </div>
  )
}
