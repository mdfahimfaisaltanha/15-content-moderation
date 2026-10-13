import { Pool } from "pg"

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.")
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10, // the load test drives real concurrency through this pool
      idleTimeoutMillis: 30_000,
    })
  }
  return pool
}
