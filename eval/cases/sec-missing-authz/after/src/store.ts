const data = new Map<string, unknown>()
export const users = { list: () => [...data.values()], remove: (id: string) => data.delete(id) }
