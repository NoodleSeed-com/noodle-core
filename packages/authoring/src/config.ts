const CONFIG_REF = Symbol.for('noodle.authoring.configRef');
const CONFIG_REF_NAME = /^[A-Za-z0-9_]+$/;

export type ConfigRefKind = 'variable' | 'secret';

export interface ConfigRef {
  readonly [CONFIG_REF]: true;
  readonly kind: ConfigRefKind;
  readonly name: string;
  toExpression(): string;
  toString(): string;
}

export function variable(name: string): ConfigRef {
  return makeConfigRef('variable', name);
}

export function secret(name: string): ConfigRef {
  return makeConfigRef('secret', name);
}

export function isConfigRef(value: unknown): value is ConfigRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [CONFIG_REF]?: unknown })[CONFIG_REF] === true
  );
}

export function serializeVariableRef(ref: ConfigRef, path: string): string {
  if (ref.kind === 'variable') return ref.toExpression();
  throw new Error(`${path}: secret("${ref.name}") can only be used in connector credential slots`);
}

export function serializeSecretRef(ref: ConfigRef, path: string): string {
  if (ref.kind === 'secret') return ref.name;
  throw new Error(`${path}: variable("${ref.name}") cannot be used as a connector secret`);
}

function makeConfigRef(kind: ConfigRefKind, name: string): ConfigRef {
  if (!CONFIG_REF_NAME.test(name)) {
    throw new Error(`${kind} reference "${name}" must match [A-Za-z0-9_]+`);
  }
  return {
    [CONFIG_REF]: true,
    kind,
    name,
    toExpression() {
      if (kind !== 'variable') {
        throw new Error(`secret("${name}") can only be used in connector credential slots`);
      }
      return `\${env.${name}}`;
    },
    toString() {
      return kind === 'variable' ? `\${env.${name}}` : `secret("${name}")`;
    },
  };
}
