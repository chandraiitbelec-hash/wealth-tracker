'use client'

import { useState } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'
import { AllocationSlice } from '@/types/portfolio'
import { fmtCurrency, fmt } from '@/lib/portfolio'

interface Props {
  data: AllocationSlice[]
  title: string
}


export default function AllocationChart({ data, title }: Props) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  if (!data.length) return null

  const total = data.reduce((s, d) => s + d.value, 0)
  const active = activeIndex !== null ? data[activeIndex] : null

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <h3 className="font-semibold text-gray-800 mb-4">{title}</h3>
      <div className="flex flex-col lg:flex-row items-center gap-6">

        {/* Donut with centre label */}
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
                onMouseEnter={(_: any, index: number) => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(null)}
              >
                {data.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.color}
                    stroke="none"
                    opacity={activeIndex === null || activeIndex === i ? 1 : 0.45}
                  />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>

          {/* Centre label — shows hovered slice or total */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center px-2">
            {active ? (
              <>
                <span className="text-xs font-medium text-gray-500 leading-tight truncate w-full text-center px-4">
                  {active.name}
                </span>
                <span className="text-base font-bold text-gray-900 mt-0.5">
                  {fmtCurrency(active.value)}
                </span>
                <span className="text-xs font-semibold" style={{ color: active.color }}>
                  {fmt(active.percent)}%
                </span>
              </>
            ) : (
              <>
                <span className="text-xs text-gray-400">Total</span>
                <span className="text-base font-bold text-gray-800">{fmtCurrency(total)}</span>
              </>
            )}
          </div>
        </div>

        {/* Legend with bars */}
        <div className="flex-1 w-full space-y-2">
          {data.map((slice, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 rounded-lg px-1 py-0.5 transition-opacity ${
                activeIndex !== null && activeIndex !== i ? 'opacity-40' : 'opacity-100'
              }`}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: slice.color }} />
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-gray-700 truncate pr-2">{slice.name}</span>
                  <span className="text-xs font-semibold text-gray-500 shrink-0">{fmt(slice.percent)}%</span>
                </div>
                <div className="mt-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{ width: `${slice.percent}%`, backgroundColor: slice.color }}
                  />
                </div>
              </div>
              <span className="text-xs text-gray-400 shrink-0 w-20 text-right">{fmtCurrency(slice.value)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
