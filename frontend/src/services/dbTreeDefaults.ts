export function treeDefaultDbName(dbType: string | undefined, dbName: string | undefined): string {
  if (dbType === 'oracle') {
    return ''
  }
  return dbName || ''
}
