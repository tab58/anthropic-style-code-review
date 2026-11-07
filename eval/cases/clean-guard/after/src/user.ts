export interface User {
  name?: string
}

export function greet(user: User): string {
  const name = user.name?.trim()
  return name ? `Hello, ${name}` : 'Hello'
}
