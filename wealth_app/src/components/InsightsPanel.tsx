'use client'

import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { InsightsReport, Insight, Severity } from '@/lib/insights'

interface Props {
  report:                InsightsReport | null
  loading?:              boolean
  /** Called when the user uploads an MF transaction file from the ELSS card */
  onMFTransactionUpload?: (file: File) => void
}

const SEVERITY_CONFIG: Record<Severity, { bg: string; border: string; badge: string; dot: string; label: string }> = {
  critical: {
    bg: 'bg-red-50',
    border: 'border-red-200',
    badge: 'bg-red-100 text-red-700',
    dot: 'bg-red-500',
    label: 'Critical',
  },
  warning: {
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    badge: 'bg-amber-100 text-amber-700',
    dot: 'bg-amber-500',
    label: 'Warning',
  },
  info: {
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    badge: 'bg-blue-100 text-blue-700',
    dot: 'bg-blue-500',
    label: 'Info',
  },
  positive: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    badge: 'bg-emerald-100 text-emerald-700',
    dot: 'bg-emerald-500',
    label: 'Good',
  },
}

function ScoreArc({ score }: { score: number }) {
  // SVG arc gauge
  const r = 56
  const cx = 72
  const cy = 72
  const startAngle = -210
  const endAngle = 30
  const totalDeg = endAngle - startAngle  // 240°
  const fillDeg = (score / 100) * totalDeg

  function polarToXY(deg: number, radius: number) {
    const rad = ((deg - 90) * Math.PI) / 180
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) }
  }

  function describeArc(from: number, to: number, radius: number) {
    const s = polarToXY(from, radius)
    const e = polarToXY(to, radius)
    const large = to - from > 180 ? 1 : 0
    return `M ${s.x} ${s.y} A ${radius} ${radius} 0 ${large} 1 ${e.x} ${e.y}`
  }

  const color =
    score >= 80 ? '#10b981' :
    score >= 60 ? '#6366f1' :
    score >= 40 ? '#f59e0b' : '#ef4444'

  return (
    <svg width="144" height="100" viewBox="0 0 144 100" className="mx-auto">
      {/* Track */}
      <path
        d={describeArc(startAngle, endAngle, r)}
        fill="none"
        stroke="#e5e7eb"
        strokeWidth="10"
        strokeLinecap="round"
      />
      {/* Fill */}
      {score > 0 && (
        <path
          d={describeArc(startAngle, startAngle + fillDeg, r)}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
        />
      )}
      {/* Score text */}
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="22" fontWeight="700" fill={color}>
        {score}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize="10" fill="#6b7280">
        / 100
      </text>
    </svg>
  )
}

function InsightCard({
  insight,
  onMFTransactionUpload,
}: {
  insight: Insight
  onMFTransactionUpload?: (file: File) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const cfg = SEVERITY_CONFIG[insight.severity]

  const isELSS = insight.id === 'elss_summary' && !!onMFTransactionUpload

  async function handleFile(file: File) {
    setUploading(true)
    try {
      await onMFTransactionUpload!(file)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div
      className={`rounded-2xl border p-4 ${cfg.bg} ${cfg.border} transition-shadow hover:shadow-sm`}
      onClick={() => setExpanded(!expanded)}
      style={{ cursor: 'pointer' }}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1 w-2.5 h-2.5 rounded-full shrink-0 ${cfg.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-gray-800 leading-snug">{insight.title}</p>
            {insight.metric && (
              <span className={`shrink-0 text-xs font-bold px-2 py-0.5 rounded-md ${cfg.badge}`}>
                {insight.metric}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-600 mt-0.5 leading-relaxed">{insight.description}</p>

          {/* Inline upload for ELSS card */}
          {isELSS && (
            <div className="mt-3" onClick={e => e.stopPropagation()}>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) handleFile(f)
                  e.target.value = ''
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 rounded-xl transition"
              >
                <Upload className="w-3.5 h-3.5" />
                {uploading ? 'Processing…' : 'Upload MF transaction statement'}
              </button>
              <p className="mt-1.5 text-xs text-gray-400">
                Groww: Account → Statements → MF Order History &nbsp;·&nbsp; Zerodha: Console → Reports → Tradebook
              </p>
            </div>
          )}

          {expanded && insight.detail && (
            <div className="mt-3 pt-3 border-t border-gray-200">
              <p className="text-xs text-gray-700 whitespace-pre-line leading-relaxed">{insight.detail}</p>
            </div>
          )}

          {insight.detail && (
            <p className="text-xs text-indigo-500 mt-2 select-none">
              {expanded ? '▲ less' : '▼ more'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function InsightsPanel({ report, loading, onMFTransactionUpload }: Props) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="animate-spin w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full" />
      </div>
    )
  }

  if (!report) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center text-gray-400">
        Insights will appear after your portfolio loads.
      </div>
    )
  }

  const labelColor =
    report.healthScore >= 80 ? 'text-emerald-600' :
    report.healthScore >= 60 ? 'text-indigo-600' :
    report.healthScore >= 40 ? 'text-amber-600' : 'text-red-500'

  const criticalCount = report.insights.filter(i => i.severity === 'critical').length
  const warningCount  = report.insights.filter(i => i.severity === 'warning').length

  return (
    <div className="space-y-6">
      {/* Health Score Hero */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <div className="flex flex-col sm:flex-row items-center gap-6">
          <div className="text-center shrink-0">
            <ScoreArc score={report.healthScore} />
            <p className={`text-base font-bold mt-1 ${labelColor}`}>{report.healthLabel}</p>
            <p className="text-xs text-gray-400">Portfolio Health Score</p>
          </div>

          <div className="flex-1 w-full">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Score Breakdown</h3>
            <div className="space-y-2.5">
              {report.scoreBreakdown.map((dim) => (
                <div key={dim.label}>
                  <div className="flex justify-between text-xs text-gray-600 mb-1">
                    <span>{dim.label}</span>
                    <span className="font-medium">{dim.score} / {dim.max}</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-all"
                      style={{ width: `${(dim.score / dim.max) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Summary pills */}
          <div className="flex sm:flex-col gap-2 shrink-0">
            {criticalCount > 0 && (
              <div className="text-center bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                <p className="text-2xl font-bold text-red-600">{criticalCount}</p>
                <p className="text-xs text-red-500">Critical</p>
              </div>
            )}
            {warningCount > 0 && (
              <div className="text-center bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                <p className="text-2xl font-bold text-amber-600">{warningCount}</p>
                <p className="text-xs text-amber-500">Warning{warningCount > 1 ? 's' : ''}</p>
              </div>
            )}
            {criticalCount === 0 && warningCount === 0 && (
              <div className="text-center bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
                <p className="text-2xl font-bold text-emerald-600">✓</p>
                <p className="text-xs text-emerald-500">All good</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Insight cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {report.insights.map((insight) => (
          <InsightCard
            key={insight.id}
            insight={insight}
            onMFTransactionUpload={insight.id === 'elss_summary' ? onMFTransactionUpload : undefined}
          />
        ))}
      </div>

      <p className="text-xs text-center text-gray-400">
        Insights are for informational purposes only and do not constitute investment advice.
      </p>
    </div>
  )
}
