import { NextRequest, NextResponse } from 'next/server'
import { computeInsights } from '@/lib/insights'
import { ParsedPortfolio } from '@/types/portfolio'

export async function POST(req: NextRequest) {
  try {
    const portfolio: ParsedPortfolio = await req.json()
    const report = computeInsights(portfolio)
    return NextResponse.json(report)
  } catch (err: any) {
    console.error('[/api/insights]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
