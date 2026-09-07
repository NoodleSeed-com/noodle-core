export function runSharePointListCompute(
  input: Record<string, unknown>,
  host?: {
    readonly callOperation?: (name: string, args: Readonly<Record<string, unknown>>) => unknown;
  },
): { result: unknown } {
  const asObject = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  const bool = (value: unknown): boolean | undefined =>
    typeof value === 'boolean' ? value : undefined;
  const values = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    const record = asObject(value);
    return Array.isArray(record?.value) ? record.value : [];
  };
  const compact = (record: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value !== undefined) out[key] = value;
    }
    return out;
  };
  const normalizedKey = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');
  const columnType = (column: Record<string, unknown>): string => {
    if (asObject(column.choice) !== undefined) return 'choice';
    if (asObject(column.number) !== undefined) return 'number';
    if (asObject(column.boolean) !== undefined) return 'boolean';
    if (asObject(column.dateTime) !== undefined) return 'dateTime';
    if (asObject(column.text) !== undefined) return 'text';
    return 'unknown';
  };
  const summarizeColumns = (raw: unknown): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (const value of values(raw)) {
      const column = asObject(value);
      const columnId = str(column?.id);
      const name = str(column?.name);
      if (column === undefined || columnId === undefined || name === undefined) continue;
      const choice = asObject(column.choice);
      const choices = Array.isArray(choice?.choices)
        ? choice.choices.filter((item): item is string => typeof item === 'string')
        : undefined;
      out.push(
        compact({
          columnId,
          name,
          displayName: str(column.displayName),
          type: columnType(column),
          required: bool(column.required) === true ? true : undefined,
          hidden: bool(column.hidden) === true ? true : undefined,
          readOnly: bool(column.readOnly) === true ? true : undefined,
          choices: choices && choices.length > 0 ? choices : undefined,
        }),
      );
    }
    return out;
  };
  const graphColumnFromInput = (
    value: unknown,
  ): { graph: Record<string, unknown>; summary: Record<string, unknown> } | undefined => {
    if (typeof value === 'string') {
      const name = value.trim();
      if (name.length === 0) return undefined;
      return { graph: { name, text: {} }, summary: { name, type: 'text' } };
    }

    const inputColumn = asObject(value);
    const name = str(inputColumn?.name);
    if (inputColumn === undefined || name === undefined) return undefined;
    const requestedType = str(inputColumn.type);
    if (requestedType === 'number') {
      return { graph: { name, number: {} }, summary: { name, type: 'number' } };
    }
    if (requestedType === 'boolean') {
      return { graph: { name, boolean: {} }, summary: { name, type: 'boolean' } };
    }
    if (requestedType === 'dateTime') {
      return { graph: { name, dateTime: {} }, summary: { name, type: 'dateTime' } };
    }
    if (requestedType === 'choice') {
      const choices = Array.isArray(inputColumn.choices)
        ? inputColumn.choices.filter((item): item is string => typeof item === 'string')
        : [];
      if (choices.length === 0) {
        throw new Error(`Choice column "${name}" must include a non-empty choices array.`);
      }
      return {
        graph: { name, choice: { choices } },
        summary: { name, type: 'choice', choices },
      };
    }
    if (requestedType === 'text' || requestedType === undefined) {
      const passthroughKeys = ['text', 'number', 'boolean', 'dateTime', 'choice'];
      const explicitKey = passthroughKeys.find((key) => asObject(inputColumn[key]) !== undefined);
      if (explicitKey !== undefined) {
        const graph = { ...inputColumn };
        delete graph.type;
        delete graph.choices;
        const summary = compact({
          name,
          type: explicitKey,
          choices:
            explicitKey === 'choice'
              ? (asObject(inputColumn.choice)?.choices as unknown[] | undefined)
              : undefined,
        });
        return { graph, summary };
      }
      return { graph: { name, text: {} }, summary: { name, type: 'text' } };
    }
    throw new Error(
      `Unsupported column type "${requestedType}" for "${name}". Use text, number, boolean, dateTime, or choice.`,
    );
  };
  const normalizeCreateListColumns = (): { result: Record<string, unknown> } => {
    if (!Array.isArray(input.columns)) return { result: {} };
    const columns: Record<string, unknown>[] = [];
    const normalizedColumns: Record<string, unknown>[] = [];
    for (const value of input.columns) {
      const normalized = graphColumnFromInput(value);
      if (normalized === undefined) continue;
      columns.push(normalized.graph);
      normalizedColumns.push(normalized.summary);
    }
    if (columns.length === 0) return { result: {} };
    return { result: { columns, normalizedColumns } };
  };
  const coerceValue = (column: Record<string, unknown>, rawValue: unknown): unknown => {
    const name = str(column.displayName) ?? str(column.name) ?? 'column';
    const type = str(column.type) ?? 'unknown';
    if (type === 'text') {
      if (
        typeof rawValue === 'string' ||
        typeof rawValue === 'number' ||
        typeof rawValue === 'boolean'
      ) {
        return String(rawValue);
      }
      throw new Error(`Column "${name}" expects a text value.`);
    }
    if (type === 'number') {
      if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
      if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
        const parsed = Number(rawValue);
        if (Number.isFinite(parsed)) return parsed;
      }
      throw new Error(`Column "${name}" expects a number value.`);
    }
    if (type === 'boolean') {
      if (typeof rawValue === 'boolean') return rawValue;
      if (typeof rawValue === 'string') {
        const normalized = rawValue.trim().toLowerCase();
        if (['true', 'yes', '1'].includes(normalized)) return true;
        if (['false', 'no', '0'].includes(normalized)) return false;
      }
      throw new Error(`Column "${name}" expects a boolean value.`);
    }
    if (type === 'dateTime') {
      if (typeof rawValue === 'string' && Number.isFinite(Date.parse(rawValue))) return rawValue;
      throw new Error(`Column "${name}" expects an ISO-like date/time string.`);
    }
    if (type === 'choice') {
      if (typeof rawValue !== 'string')
        throw new Error(`Column "${name}" expects a choice string.`);
      const choices = Array.isArray(column.choices)
        ? column.choices.filter((item): item is string => typeof item === 'string')
        : [];
      if (choices.length > 0 && !choices.includes(rawValue)) {
        throw new Error(`Column "${name}" must be one of: ${choices.join(', ')}.`);
      }
      return rawValue;
    }
    throw new Error(
      `Column "${name}" has unsupported type "${type}". Use sharepoint_list_list_columns before filling this field.`,
    );
  };
  const resolveListItemValues = (): { result: Record<string, unknown> } => {
    const siteId = str(input.siteId);
    const listId = str(input.listId);
    const rawValues = asObject(input.values);
    const callOperation = host?.callOperation;
    if (siteId === undefined || listId === undefined || rawValues === undefined) {
      throw new Error('siteId, listId, and values are required.');
    }
    if (callOperation === undefined) throw new Error('callOperation is required.');

    const response = callOperation('list_list_columns', { siteId, listId }) as {
      columns?: unknown;
    };
    const columns = summarizeColumns(response.columns);
    const index = new Map<string, Record<string, unknown>[]>();
    for (const column of columns) {
      for (const key of [str(column.name), str(column.displayName)]) {
        if (key === undefined) continue;
        const normalized = normalizedKey(key);
        index.set(normalized, [...(index.get(normalized) ?? []), column]);
      }
    }

    const fields: Record<string, unknown> = {};
    const resolvedFields: Record<string, string> = {};
    for (const [inputName, rawValue] of Object.entries(rawValues)) {
      const matches = index.get(normalizedKey(inputName)) ?? [];
      const unique = new Map(matches.map((column) => [str(column.name) ?? '', column]));
      if (unique.size === 0) {
        throw new Error(
          `Unknown SharePoint list column "${inputName}". Call sharepoint_list_list_columns and use a returned displayName or name.`,
        );
      }
      if (unique.size > 1) {
        throw new Error(
          `Ambiguous SharePoint list column "${inputName}". Use the internal column name.`,
        );
      }
      const column = [...unique.values()][0] as Record<string, unknown>;
      const fieldName = str(column.name);
      if (fieldName === undefined) {
        throw new Error(`Column "${inputName}" is missing an internal name.`);
      }
      if (column.hidden === true) throw new Error(`Column "${inputName}" is hidden.`);
      if (column.readOnly === true) throw new Error(`Column "${inputName}" is read-only.`);
      fields[fieldName] = coerceValue(column, rawValue);
      resolvedFields[inputName] = fieldName;
    }
    return { result: { fields, resolvedFields } };
  };

  if (input.kind === 'columns') return { result: summarizeColumns(input.columns) };
  if (input.kind === 'create_list_columns') return normalizeCreateListColumns();
  if (input.kind === 'list_item_values') return resolveListItemValues();
  return { result: input };
}
