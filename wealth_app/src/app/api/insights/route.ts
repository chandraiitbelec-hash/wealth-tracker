import { NextRequest, NextResponse } from 'next/server'
import { computeInsights, ELSSFYData } from '@/lib/insights'
import { ParsedPortfolio } from '@/types/portfolio'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    // Support both plain portfolio (legacy) and { portfolio, fyData } shape
    const portfolio: ParsedPortfolio = body.portfolio ?? body
    const fyData: ELSSFYData | null  = body.fyData ?? null
    const report = computeInsights(portfolio, fyData)
    return NextResponse.json(report)
  } catch (err: any) {
    console.error('[/api/insights]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
