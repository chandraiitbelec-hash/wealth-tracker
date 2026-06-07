'use client'

import { useState } from 'react'
import { StockHolding, MFHolding } from '@/types/portfolio'
import { fmtCurrency, fmt } from '@/lib/portfolio'
import { ChevronDown, ChevronUp, TrendingUp, TrendingDown } from 'lucide-react'

function PnLBadge({ value, percent }: { value: number; percent?: number }) {
  const pos = value >= 0
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${pos ? 'text-green-600' : 'text-red-500'}`}>
      {pos ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {pos ? '+' : ''}{fmtCurrency(value)}
      {percent !== undefined && (
        <span className="opacity-70">({pos ? '+' : ''}{fmt(percent)}%)</span>
      )}
    </span>
  )
}

export function StocksTable({ holdings }: { holdings: StockHolding[] }) {
  const [sortKey, setSortKey] = useState<keyof StockHolding>('closingValue')
  const [asc, setAsc] = useState(false)

  const sorted = [...holdings].sort((a, b) => {
    const va = a[sortKey] as number
    const vb = b[sortKey] as number
    return asc ? va - vb : vb - va
  })

  const toggle = (key: keyof StockHolding) => {
    if (sortKey === key) setAsc(!asc)
    else { setSortKey(key); setAsc(false) }
  }

  const Th = ({ label, k }: { label: string; k: keyof StockHolding }) => (
    <th
      className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-800 select-none"
      onClick={() => toggle(k)}
    >
      <span className="flex items-center gap-1">
        {label}
        {sortKey === k ? (asc ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : null}
      </span>
    </th>
  )

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
        <h3 className="font-semibold text-gray-800">Direct Equity Holdings</h3>
        <span className="text-xs text-gray-400 bg-gray-50 px-2 py-1 rounded-lg">{holdings.length} stocks</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Stock</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Sector</th>
              <Th label="Qty" k="quantity" />
              <Th label="Avg Price" k="avgBuyPrice" />
              <Th label="Invested" k="buyValue" />
              <Th label="CMP" k="closingPrice" />
              <Th label="Current Value" k="closingValue" />
              <Th label="P&L" k="unrealisedPnL" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sorted.map((h, i) => (
              <tr key={i} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3">
                  <div className="font-medium text-sm text-gray-900">{h.companyName || h.stockName}</div>
                  <div className="text-xs text-gray-400 font-mono">{h.symbol || h.isin}</div>
                </td>
                <td className="px-4 py-3">
                  {h.sector ? (
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-md">{h.sector}</span>
                  ) : (
                    <span className="text-xs text-gray-300">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-gray-700">{h.quantity}</td>
                <td className="px-4 py-3 text-sm text-gray-700">₹{fmt(h.avgBuyPrice)}</td>
                <td className="px-4 py-3 text-sm text-gray-700">{fmtCurrency(h.buyValue)}</td>
                <td className="px-4 py-3">
                  <div className="text-sm text-gray-700">₹{fmt(h.closingPrice)}</div>
                  {h.ourPrice && h.ourPrice !== h.closingPrice && (
                    <div className="text-xs text-indigo-500">Live: ₹{fmt(h.ourPrice)}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{fmtCurrency(h.closingValue)}</td>
                <td className="px-4 py-3">
                  <PnLBadge value={h.unrealisedPnL} percent={h.pnlPercent} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function MFTable({ holdings }: { holdings: MFHolding[] }) {
  const [sortKey, setSortKey] = useState<keyof MFHolding>('currentValue')
  const [asc, setAsc] = useState(false)

  const sorted = [...holdings].sort((a, b) => {
    const va = a[sortKey] as number
    const vb = b[sortKey] as number
    return asc ? va - vb : vb - va
  })

  const toggle = (key: keyof MFHolding) => {
    if (sortKey === key) setAsc(!asc)
    else { setSortKey(key); setAsc(false) }
  }

  const Th = ({ label, k }: { label: string; k: keyof MFHolding }) => (
    <th
      className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-800 select-none"
      onClick={() => toggle(k)}
    >
      <span className="flex items-center gap-1">
        {label}
        {sortKey === k ? (asc ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : null}
      </span>
    </th>
  )

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
        <h3 className="font-semibold text-gray-800">Mutual Fund Holdings</h3>
        <span className="text-xs text-gray-400 bg-gray-50 px-2 py-1 rounded-lg">{holdings.length} schemes</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Scheme</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Category</th>
              <Th label="Units" k="units" />
              <Th label="Invested" k="investedValue" />
              <Th label="Current Value" k="currentValue" />
              <Th label="Returns" k="returns" />
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">XIRR</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sorted.map((h, i) => (
              <tr key={i} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 max-w-xs">
                  <div className="font-medium text-sm text-gray-900 leading-tight">{h.schemeName}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{h.amc}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-block text-xs bg-indigo-50 text-indigo-600 font-medium px-2 py-0.5 rounded-lg">
                    {h.subCategory || h.category}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-700">{fmt(h.units, 3)}</td>
                <td className="px-4 py-3 text-sm text-gray-700">{fmtCurrency(h.investedValue)}</td>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{fmtCurrency(h.currentValue)}</td>
                <td className="px-4 py-3">
                  <PnLBadge
                    value={h.returns}
                    percent={h.investedValue > 0 ? (h.returns / h.investedValue) * 100 : 0}
                  />
                </td>
                <td className="px-4 py-3 text-sm font-semibold text-indigo-600">{h.xirr}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
