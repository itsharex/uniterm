export function quoteDbIdentifier(dbType: string | undefined, name: string): string {
  if (dbType === 'oracle' || dbType === 'postgres') {
    return `"${name.replace(/"/g, '""')}"`
  }
  if (dbType === 'rqlite') {
    return `"${name.replace(/"/g, '""')}"`
  }
  return `\`${name.replace(/`/g, '``')}\``
}

export function buildDefaultTableQuery(dbType: string | undefined, tableName: string): string {
  const quotedTable = quoteDbIdentifier(dbType, tableName)
  if (dbType === 'oracle') {
    return `SELECT * FROM ${quotedTable} WHERE ROWNUM <= 100`
  }
  return `SELECT * FROM ${quotedTable} LIMIT 100`
}
