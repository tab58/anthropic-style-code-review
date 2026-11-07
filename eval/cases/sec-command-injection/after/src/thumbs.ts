import { execSync } from 'node:child_process'
import type { Request, Response } from 'express'

export function health(_req: Request, res: Response) {
  res.send('ok')
}

export function thumbnail(req: Request, res: Response) {
  const file = String(req.query.file)
  execSync(`convert uploads/${file} -resize 128x128 thumbs/${file}`)
  res.send('done')
}
