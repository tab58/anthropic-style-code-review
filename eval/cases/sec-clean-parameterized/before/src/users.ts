import type { Request, Response } from 'express'
import { db } from './db'

export async function getUser(req: Request, res: Response) {
  const rows = await db.query('SELECT id, name FROM users WHERE id = $1', [req.params.id])
  res.json(rows[0])
}
