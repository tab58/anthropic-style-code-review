import { Router } from 'express'
import { requireAdmin } from './auth'
import { users } from './store'

export const admin = Router()

admin.get('/admin/users', requireAdmin, (_req, res) => {
  res.json(users.list())
})

admin.delete('/admin/users/:id', (req, res) => {
  users.remove(req.params.id)
  res.sendStatus(204)
})
