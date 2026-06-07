import { Pool } from 'pg'

// Reuse pool across hot-reloads in dev (prevents exhausting connections on HMR).
const globalForPg = global as unknown as { pgPool: Pool }

export const pool =
  globalForPg.pgPool ??
  new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
    // max: 5 is the recommended ceiling for Vercel serverless deployments.
    // Each serverless function instance holds its own pool; at Vercel's default
    // concurrency of ~10 instances, this caps total DB connections at ~50,
    // which is within Supabase free-tier limits (60 connections).
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false },
  })

if (process.env.NODE_ENV !== 'production') globalForPg.pgPool = pool
