'use client'

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { AllocationSlice } from '@/types/portfolio'
import { fmtCurrency, fmt } from '@/lib/portfolio'

interface Props {
  data: AllocationSlice[]
  title: string
  centerLabel?: string
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-lg px-4 py-3 text-sm">
      <p className="font-semibold text-gray-800">{d.name}</p>
      <p className="text-gray-500">{fmtCurrency(d.value)}</p>
      <p className="text-indigo-600 font-medium">{fmt(d.percent)}%</p>
    </div>
  )
}

export default function AllocationChart({ data, title, centerLabel }: Props) {
  if (!data.length) return null

  const total = data.reduce((s, d) => s + d.value, 0)

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <h3 className="font-semibold text-gray-800 mb-4">{title}</h3>
      <div className="flex flex-col lg:flex-row items-center gap-6">
        <div className="relative w-52 h-52 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={65}
                outerRadius={95}
                paddingAngle={2}
                dataKey="value"
              >
                {data.map((entry, i) => (
                  <Cell key={i} fill={entry.color} stroke="none" />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-xs text-gray-400">Total</span>
            <span className="text-base font-bold text-gray-800">{fmtCurrency(total)}</span>
          </div>
        </div>

        <div className="flex-1 w-full space-y-2">
          {data.map((slice, i) => (
            <div key={i} className="flex items-center gap-3">
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: slice.color }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-gray-700 truncate pr-2">{slice.name}</span>
                  <span className="text-xs font-semibold text-gray-500 shrink-0">{fmt(slice.percent)}%</span>
                </div>
                <div className="mt-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${slice.percent}%`, backgroundColor: slice.color }}
                  />
                </div>
              </div>
              <span className="text-xs text-gray-400 shrink-0 w-20 text-right">
                {fmtCurrency(slice.value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
