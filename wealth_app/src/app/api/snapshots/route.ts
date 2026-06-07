import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/snapshots — list user's snapshots
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .select('id, name, broker, snapshot_date, created_at')
    .order('snapshot_date', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ snapshots: data })
}

// POST /api/snapshots — save a new snapshot
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name, broker, portfolio } = await req.json()
  if (!portfolio) return NextResponse.json({ error: 'portfolio required' }, { status: 400 })

  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .insert({
      user_id: user.id,
      name: name || `Snapshot ${new Date().toLocaleDateString('en-IN')}`,
      broker: broker || 'Groww',
      portfolio,
    })
    .select('id, name, snapshot_date, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ snapshot: data })
}
