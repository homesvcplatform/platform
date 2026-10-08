// B2 query-tag fitness (Phase 2 02 §3): a module's SQL may touch only its own schema(s) and the shared `platform`
// schema. Every statement a module issues goes through `assertModuleOwnsSql`; a reference to another module's schema
// throws before the statement reaches the database. The static check (tools/architecture/check-sql-ownership.mjs)
// applies the same rule to SQL in module source files.

export interface SchemaOwnership {
  /** module name -> schemas it owns */
  readonly modules: Readonly<Record<string, readonly string[]>>;
  /** schemas any module may use (outbox, idempotency) */
  readonly shared: readonly string[];
}

export class ModuleBoundaryError extends Error {
  readonly module: string;
  readonly foreignSchemas: readonly string[];

  constructor(module: string, foreignSchemas: readonly string[]) {
    super(`module "${module}" may not access schema(s) ${foreignSchemas.join(', ')} (B2): use the owning module's facade`);
    this.name = 'ModuleBoundaryError';
    this.module = module;
    this.foreignSchemas = foreignSchemas;
  }
}

/** Removes comments, quoted literals and dollar-quoted bodies so only SQL structure remains. */
function stripNonCode(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Schema names (from `knownSchemas`) referenced as `schema.object` in the statement. */
export function referencedSchemas(sql: string, knownSchemas: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const code = stripNonCode(sql);
  for (const match of code.matchAll(/(?<![\w.])"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\.\s*"?[A-Za-z_]/g)) {
    const schema = (match[1] ?? '').toLowerCase();
    if (knownSchemas.has(schema)) found.add(schema);
  }
  return found;
}

export function allSchemas(ownership: SchemaOwnership): Set<string> {
  return new Set([...Object.values(ownership.modules).flat(), ...ownership.shared]);
}

export function assertModuleOwnsSql(module: string, sql: string, ownership: SchemaOwnership): void {
  const owned = ownership.modules[module];
  if (!owned) throw new ModuleBoundaryError(module, ['<unknown module>']);
  const allowed = new Set([...owned, ...ownership.shared]);
  const foreign = [...referencedSchemas(sql, allSchemas(ownership))].filter((s) => !allowed.has(s)).sort();
  if (foreign.length > 0) throw new ModuleBoundaryError(module, foreign);
}

/** Builds the ownership map from tools/architecture/modules.json content. */
export function ownershipFromModulesJson(spec: {
  modules: Record<string, { schema: string; additionalSchemas?: string[] }>;
  sharedSchemas?: string[];
}): SchemaOwnership {
  const modules: Record<string, string[]> = {};
  for (const [name, def] of Object.entries(spec.modules)) modules[name] = [def.schema, ...(def.additionalSchemas ?? [])];
  return { modules, shared: spec.sharedSchemas ?? [] };
}
