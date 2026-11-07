export interface Db {
  write(key: string, value: string): Promise<void>
}

export async function save(db: Db, key: string, value: string): Promise<{ ok: true }> {
  await db.write(key, value)
  return { ok: true }
}
