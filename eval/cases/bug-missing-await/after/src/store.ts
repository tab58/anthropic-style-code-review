export interface Db {
  write(key: string, value: string): Promise<void>
}

export async function save(db: Db, key: string, value: string): Promise<{ ok: true }> {
  await db.write(key, value)
  return { ok: true }
}

export async function saveAll(db: Db, entries: Record<string, string>): Promise<{ ok: true; count: number }> {
  for (const [key, value] of Object.entries(entries)) {
    db.write(key, value)
  }
  return { ok: true, count: Object.keys(entries).length }
}
