export interface ModuleSqlQueryResult<Row extends object = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

/** A borrowed transaction facade. It deliberately exposes no pool or transaction lifecycle methods. */
export interface ModuleSqlTransaction {
  query<Row extends object = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<ModuleSqlQueryResult<Row>>;
}
