import { Pool } from 'pg'

// Reuse pool across hot-reloads in dev
const globalForPg = global as unknown as { pgPool: Pool }

export const pool =
  globalForPg.pgPool ??
  new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false },
  })

if (process.env.NODE_ENV !== 'production') globalForPg.pgPool = pool
