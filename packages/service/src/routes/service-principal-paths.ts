export type ServicePrincipalPath =
  | { readonly kind: 'collection'; readonly org: string }
  | { readonly kind: 'principal'; readonly org: string; readonly principalId: string }
  | { readonly kind: 'grants'; readonly org: string; readonly principalId: string }
  | {
      readonly kind: 'grant';
      readonly org: string;
      readonly principalId: string;
      readonly grantId: string;
    }
  | { readonly kind: 'credentials'; readonly org: string; readonly principalId: string }
  | {
      readonly kind: 'credential';
      readonly org: string;
      readonly principalId: string;
      readonly credentialId: string;
    };

const PRINCIPAL = 'spn_[0-9a-f-]{36}';
const GRANT = 'spg_[0-9a-f-]{36}';
const CREDENTIAL = 'spc_[0-9a-f-]{36}';

/** Parse only the exact organization-scoped service-principal management family. */
export function parseServicePrincipalPath(pathname: string): ServicePrincipalPath | undefined {
  const collection = /^\/v1\/orgs\/([^/]+)\/service-principals$/.exec(pathname);
  if (collection !== null) return { kind: 'collection', org: decode(collection[1]) };

  const credentials = new RegExp(
    `^/v1/orgs/([^/]+)/service-principals/(${PRINCIPAL})/credentials$`,
  ).exec(pathname);
  if (credentials !== null) {
    return {
      kind: 'credentials',
      org: decode(credentials[1]),
      principalId: credentials[2] as string,
    };
  }
  const credential = new RegExp(
    `^/v1/orgs/([^/]+)/service-principals/(${PRINCIPAL})/credentials/(${CREDENTIAL})$`,
  ).exec(pathname);
  if (credential !== null) {
    return {
      kind: 'credential',
      org: decode(credential[1]),
      principalId: credential[2] as string,
      credentialId: credential[3] as string,
    };
  }
  const grants = new RegExp(`^/v1/orgs/([^/]+)/service-principals/(${PRINCIPAL})/grants$`).exec(
    pathname,
  );
  if (grants !== null) {
    return {
      kind: 'grants',
      org: decode(grants[1]),
      principalId: grants[2] as string,
    };
  }
  const grant = new RegExp(
    `^/v1/orgs/([^/]+)/service-principals/(${PRINCIPAL})/grants/(${GRANT})$`,
  ).exec(pathname);
  if (grant !== null) {
    return {
      kind: 'grant',
      org: decode(grant[1]),
      principalId: grant[2] as string,
      grantId: grant[3] as string,
    };
  }
  const principal = new RegExp(`^/v1/orgs/([^/]+)/service-principals/(${PRINCIPAL})$`).exec(
    pathname,
  );
  if (principal !== null) {
    return {
      kind: 'principal',
      org: decode(principal[1]),
      principalId: principal[2] as string,
    };
  }
  return undefined;
}

function decode(value: string | undefined): string {
  if (value === undefined) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}
