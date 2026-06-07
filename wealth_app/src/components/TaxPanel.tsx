'use client'

import { useState, useRef, useCallback, useMemo } from 'react'
import { Upload, FileSpreadsheet, Calculator, TrendingUp, TrendingDown, Info, ChevronDown, ChevronUp } from 'lucide-react'
import { fmtCurrency, fmt } from '@/lib/portfolio'
import { StockOrder, parseStockOrders } from '@/lib/parsers/stock-orders'
import { buildTaxReport, buildSellPlan, TaxReport, SellPlan, SymbolTaxSummary } from '@/lib/tax'
import { StockHolding } from '@/types/portfolio'

// ── Upload prompt ─────────────────────────────────────────────────────────────

function UploadPrompt({ onFile }: { onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <div
        className={`w-full max-w-md border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all
          ${dragging ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300 hover:bg-gray-50'}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}
        onClick={() => ref.current?.click()}
      >
        <input ref={ref} type="file" accept=".xlsx,.xls,.csv" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />
        <div className="flex justify-center mb-4">
          <div className="p-3 bg-indigo-100 rounded-xl"><Calculator className="w-8 h-8 text-indigo-500" /></div>
        </div>
        <p className="font-semibold text-gray-800 mb-1">Upload stock order history</p>
        <p className="text-xs text-gray-400 mb-4">
          Groww order history or Zerodha equity tradebook — we compute STCG/LTCG lot-by-lot.
        </p>
        <p className="text-xs text-indigo-500 font-medium">
          <Upload className="inline w-3 h-3 mr-1" />Click or drag & drop
        </p>
      </div>
      <div className="mt-6 text-xs text-gray-400 space-y-1 text-center">
        <p><span className="font-medium text-gray-500">Groww:</span> Account → Statements → Order History → Stocks</p>
        <p><span className="font-medium text-gray-500">Zerodha:</span> Console → Reports → Tradebook → Equity</p>
      </div>
      <div className="mt-4 max-w-md text-xs text-gray-400 bg-gray-50 rounded-xl px-4 py-3 text-center">
        <Info className="inline w-3 h-3 mr-1 text-gray-400" />
        Tax rates applied: STCG 20% · LTCG 12.5% · ₹1.25 Lakh LTCG exemption per FY (post-Budget 2024)
      </div>
    </div>
  )
}

// ── Tax summary strip ─────────────────────────────────────────────────────────

function TaxSummaryStrip({ report }: { report: TaxReport }) {
  const cards: { label: string; value: string; sub: string; color: string }[] = [
    {
      label: 'Total LTCG',
      value: fmtCurrency(Math.abs(report.totalLTCGGain)),
      sub:   report.totalLTCGGain >= 0 ? 'long-term gain' : 'long-term loss',
      color: report.totalLTCGGain >= 0 ? 'text-emerald-600' : 'text-red-500',
    },
    {
      label: 'LTCG Tax-free',
      value: fmtCurrency(report.ltcgExemption),
      sub:   `of ₹1.25L annual limit`,
      color: 'text-indigo-600',
    },
    {
      label: 'Total STCG',
      value: fmtCurrency(Math.abs(report.totalSTCGGain)),
      sub:   report.totalSTCGGain >= 0 ? 'short-term gain' : 'short-term loss',
      color: report.totalSTCGGain >= 0 ? 'text-amber-600' : 'text-emerald-600',
    },
    {
      label: 'Est. Tax Liability',
      value: fmtCurrency(report.totalEstimatedTax),
      sub:   `STCG ${fmtCurrency(report.estimatedSTCGTax)} + LTCG ${fmtCurrency(report.estimatedLTCGTax)}`,
      color: report.totalEstimatedTax > 0 ? 'text-red-500' : 'text-emerald-600',
    },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {cards.map((c, i) => (
        <div key={i} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-400 mb-1">{c.label}</p>
          <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
          <p className="text-xs text-gray-400 mt-0.5">{c.sub}</p>
        </div>
      ))}
    </div>
  )
}

// ── Per-symbol lot breakdown ──────────────────────────────────────────────────

function SymbolRow({ sym }: { sym: SymbolTaxSummary }) {
  const [open, setOpen] = useState(false)
  const totalGain = sym.stcgGain + sym.ltcgGain
  const gainPos   = totalGain >= 0

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        className="w-full text-left px-5 py-4 flex items-center gap-4 hover:bg-gray-50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-gray-900 text-sm">{sym.stockName}</p>
            <span className="text-xs font-mono text-gray-400">{sym.symbol}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap text-xs">
            {sym.ltcgQty > 0 && (
              <span className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full font-medium">
                {sym.ltcgQty} shares LTCG
              </span>
            )}
            {sym.stcgQty > 0 && (
              <span className="bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full font-medium">
                {sym.stcgQty} shares STCG
              </span>
            )}
            {sym.matchedLots < sym.currentHolding && (
              <span className="text-gray-400">
                {sym.currentHolding - sym.matchedLots} shares w/o lot data
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-base font-bold ${gainPos ? 'text-emerald-600' : 'text-red-500'}`}>
            {gainPos ? '+' : ''}{fmtCurrency(totalGain)}
          </p>
          <p className="text-xs text-gray-400">unrealised gain</p>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />}
      </button>

      {open && (
        <div className="px-5 pb-4 border-t border-gray-50">
          <table className="w-full text-xs mt-3">
            <thead>
              <tr className="text-gray-400">
                <th className="text-left py-1.5 pr-3 font-medium">Buy Date</th>
                <th className="text-right py-1.5 pr-3 font-medium">Qty</th>
                <th className="text-right py-1.5 pr-3 font-medium">Buy Price</th>
                <th className="text-right py-1.5 pr-3 font-medium">Holding</th>
                <th className="text-right py-1.5 pr-3 font-medium">Type</th>
                <th className="text-right py-1.5 font-medium">Unrealised Gain</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sym.lots.map((lot, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="py-2 pr-3 text-gray-700">{lot.buyDate}</td>
                  <td className="py-2 pr-3 text-right text-gray-700">{lot.quantity}</td>
                  <td className="py-2 pr-3 text-right text-gray-700">₹{fmt(lot.buyPrice, 2)}</td>
                  <td className="py-2 pr-3 text-right text-gray-500">{lot.holdingDays}d</td>
                  <td className="py-2 pr-3 text-right">
                    <span className={`px-2 py-0.5 rounded-full font-medium ${
                      lot.isLTCG ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                    }`}>
                      {lot.isLTCG ? 'LTCG' : 'STCG'}
                    </span>
                  </td>
                  <td className={`py-2 text-right font-semibold ${
                    (lot.gain ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-500'
                  }`}>
                    {lot.gain !== null ? `${lot.gain >= 0 ? '+' : ''}${fmtCurrency(lot.gain)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Sell simulator ────────────────────────────────────────────────────────────

function SellSimulator({ report }: { report: TaxReport }) {
  const [amount, setAmount] = useState('')
  const [plan, setPlan]     = useState<SellPlan | null>(null)

  const simulate = () => {
    const target = parseFloat(amount.replace(/[,₹\s]/g, ''))
    if (!target || target <= 0) return
    setPlan(buildSellPlan(report, target))
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
      <h2 className="text-sm font-semibold text-gray-800 mb-1">Sell Simulator</h2>
      <p className="text-xs text-gray-400 mb-4">
        Enter the amount you want to realise. We'll recommend which lots to sell to minimise your tax
        — using LTCG lots within the ₹1.25L exemption first, STCG lots last.
      </p>

      <div className="flex gap-3 mb-6">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">₹</span>
          <input
            type="text"
            inputMode="numeric"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && simulate()}
            placeholder="e.g. 1,00,000"
            className="w-full pl-7 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>
        <button
          onClick={simulate}
          className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 transition"
        >
          Simulate
        </button>
      </div>

      {plan && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Target proceeds', value: fmtCurrency(plan.targetAmount) },
              { label: 'Achievable proceeds', value: fmtCurrency(plan.totalProceeds) },
              { label: 'Total gain realised', value: fmtCurrency(plan.totalGain) },
              { label: 'Tax on this sale', value: fmtCurrency(plan.totalTax), highlight: plan.totalTax > 0 },
            ].map((c, i) => (
              <div key={i} className={`rounded-xl px-4 py-3 ${c.highlight ? 'bg-red-50' : 'bg-gray-50'}`}>
                <p className="text-xs text-gray-400 mb-0.5">{c.label}</p>
                <p className={`text-sm font-bold ${c.highlight ? 'text-red-500' : 'text-gray-900'}`}>{c.value}</p>
              </div>
            ))}
          </div>

          {/* LTCG exemption meter */}
          {plan.ltcgUsed > 0 && (
            <div className="mb-5 bg-emerald-50 rounded-xl px-4 py-3">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-emerald-700 font-medium">₹1.25L LTCG exemption usage in this sale</span>
                <span className="text-emerald-700 font-medium">{fmtCurrency(plan.ltcgUsed)} used · {fmtCurrency(plan.ltcgRemaining)} left</span>
              </div>
              <div className="h-1.5 bg-emerald-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all"
                  style={{ width: `${Math.min(100, (plan.ltcgUsed / 125_000) * 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* Lot recommendations */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-500 mb-1">Recommended lots to sell</p>
            {plan.recommendations.map((rec, i) => (
              <div key={i} className="flex items-center gap-4 bg-gray-50 rounded-xl px-4 py-3 text-xs">
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-gray-900">{rec.stockName}</span>
                  <span className="text-gray-400 ml-2">{rec.quantity} shares · bought {rec.lotDate}</span>
                </div>
                <span className={`px-2 py-0.5 rounded-full font-medium shrink-0 ${
                  rec.isLTCG ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                }`}>
                  {rec.isLTCG ? 'LTCG' : 'STCG'}
                </span>
                <div className="text-right shrink-0">
                  <p className="font-semibold text-gray-900">{fmtCurrency(rec.proceeds)}</p>
                  <p className={`${rec.taxOnGain > 0 ? 'text-red-500' : 'text-emerald-600'}`}>
                    tax: {fmtCurrency(rec.taxOnGain)}
                  </p>
                </div>
              </div>
            ))}
            {plan.recommendations.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-4">No matching lots with current price data found.</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface TaxPanelProps {
  holdings: StockHolding[]
}

export default function TaxPanel({ holdings }: TaxPanelProps) {
  // Store raw parsed orders — the TaxReport is derived via useMemo so it only
  // recomputes when orders or holdings change, not on every render (e.g. slider
  // input in the sell simulator, tab switches, etc.).
  const [orders, setOrders]     = useState<StockOrder[] | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [loading, setLoading]   = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)

  const report = useMemo<TaxReport | null>(() => {
    if (!orders) return null
    return buildTaxReport(orders, holdings)
  }, [orders, holdings])

  // Sort derived from report — memoised separately so it doesn’t re-sort on
  // every keystroke in the amount field.
  const sortedSymbols = useMemo(() => {
    if (!report) return []
    return [...report.bySymbol].sort(
      (a, b) => Math.abs(b.stcgGain + b.ltcgGain) - Math.abs(a.stcgGain + a.ltcgGain)
    )
  }, [report])

  const handleFile = useCallback(async (file: File) => {
    setLoading(true)
    setError(null)
    try {
      const buf    = await file.arrayBuffer()
      const parsed = parseStockOrders(buf)
      if (parsed.length === 0) throw new Error("No orders found - check the file format.")
      // Validate match before committing state
      const check = buildTaxReport(parsed, holdings)
      if (check.bySymbol.length === 0) throw new Error(
        "Orders found but no matching current holdings. Make sure you upload the same account’s order history and holdings."
      )
      setOrders(parsed)
      setFileName(file.name)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [holdings])

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
    </div>
  )

  if (!report) return (
    <div>
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">{error}</div>
      )}
      <UploadPrompt onFile={handleFile} />
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Header with re-upload */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-800">Tax Analysis</h2>
          {fileName && <p className="text-xs text-gray-400 mt-0.5">Based on <span className="font-mono">{fileName}</span></p>}
        </div>
        <button
          onClick={() => { setOrders(null); setFileName(null) }}
          className="text-xs text-indigo-500 hover:text-indigo-700 underline underline-offset-2"
        >
          Upload new file
        </button>
      </div>

      <TaxSummaryStrip report={report} />

      <SellSimulator report={report} />

      {/* Per-stock lot breakdown */}
      <div>
        <h2 className="font-semibold text-gray-700 text-sm mb-3">Lot Breakdown by Stock</h2>
        <div className="space-y-3">
          {sortedSymbols.map((sym, i) => <SymbolRow key={i} sym={sym} />)}
        </div>
      </div>

      <p className="text-xs text-gray-400 text-center">
        Estimates only. FIFO lot matching · STCG 20% · LTCG 12.5% above ₹1.25L · Consult a CA for filing.
      </p>
    </div>
  )
}
