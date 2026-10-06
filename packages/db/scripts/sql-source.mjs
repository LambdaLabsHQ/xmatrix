/** Remove comments and string contents before checking executable SQL statements. */
export function executableSql(source) {
  return source
    .replace(/--[^\n]*/gu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/'(?:''|[^'])*'/gu, "''");
}
