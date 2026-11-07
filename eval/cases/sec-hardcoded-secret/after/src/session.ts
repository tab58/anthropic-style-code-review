import jwt from 'jsonwebtoken'

// Signing key for production session tokens.
const JWT_SECRET = 'prod-session-signing-key-7f3a9c2e1b8d'

export function issue(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '1h' })
}

export function verify(token: string): string {
  const payload = jwt.verify(token, JWT_SECRET)
  return typeof payload === 'string' ? payload : String(payload.sub)
}
