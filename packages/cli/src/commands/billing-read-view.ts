export type ProductionAppsView =
  | { readonly state: 'reporting'; readonly active: number; readonly limit: number | null }
  | { readonly state: 'unavailable'; readonly active: null; readonly limit: number | null };

export type AccountMeteringView =
  | {
      readonly state: 'reporting';
      readonly mode: 'authoritative';
      readonly coverage: 'complete';
      readonly usedMcpCalls: number;
      readonly includedUsedMcpCalls: number;
      readonly overageUsedMcpCalls: number;
      readonly remainingMcpCalls: number;
      readonly countingSince: string;
      readonly windowStart: string;
      readonly windowEnd: string;
      readonly resetAt: string;
    }
  | {
      readonly state: 'not_started';
      readonly usedMcpCalls: null;
      readonly remainingMcpCalls: null;
      readonly resetAt: null;
    }
  | {
      readonly state: 'reporting';
      readonly mode: 'shadow';
      readonly observedCalls: number;
      readonly coverage: 'partial';
      readonly observedSince: string;
      readonly windowStart: string;
      readonly windowEnd: string;
      readonly remainingMcpCalls: null;
    }
  | {
      readonly state: 'unavailable';
      readonly reason: string;
      readonly observedCalls: null;
      readonly coverage: 'unavailable';
      readonly observedSince: string | null;
      readonly windowStart: string | null;
      readonly windowEnd: string | null;
      readonly remainingMcpCalls: null;
    };

export type OrgMeteringView =
  | { readonly state: 'not_started' }
  | Omit<
      Extract<AccountMeteringView, { readonly state: 'reporting'; readonly mode: 'shadow' }>,
      'remainingMcpCalls'
    >
  | {
      readonly state: 'reporting';
      readonly mode: 'authoritative';
      readonly coverage: 'complete';
      readonly attributedMcpCalls: number;
      readonly includedAttributedMcpCalls: number;
      readonly overageAttributedMcpCalls: number;
      readonly countingSince: string;
      readonly windowStart: string;
      readonly windowEnd: string;
      readonly resetAt: string;
    }
  | Omit<Extract<AccountMeteringView, { readonly state: 'unavailable' }>, 'remainingMcpCalls'>;

export type EnforcementView =
  | { readonly state: 'legacy_unchanged' }
  | { readonly state: 'exempt'; readonly reason: 'legacy_internal' }
  | { readonly state: 'inactive'; readonly reason: 'not_activated' | 'rolled_back' }
  | { readonly state: 'active'; readonly mode: 'authoritative' }
  | { readonly state: 'unavailable' };

interface DisplayValue {
  readonly value: string;
  readonly note: string;
}

export function accountProductionAppsView(productionApps: ProductionAppsView): DisplayValue {
  if (productionApps.state === 'unavailable') {
    return {
      value: 'Unavailable',
      note:
        productionApps.limit === null
          ? 'active footprint unavailable; pooled limit unavailable'
          : `active footprint unavailable; pooled limit ${formatNumber(productionApps.limit)}`,
    };
  }
  return {
    value:
      productionApps.limit === null
        ? `${formatNumber(productionApps.active)} active; limit unavailable`
        : `${formatNumber(productionApps.active)} active / ${formatNumber(productionApps.limit)} limit`,
    note: 'pooled across linked organizations; each logical active hosted app counts once',
  };
}

export function orgProductionAppsView(productionApps: ProductionAppsView): DisplayValue {
  if (productionApps.state === 'unavailable') {
    return {
      value: 'Unavailable',
      note:
        productionApps.limit === null
          ? 'org-attributed active footprint unavailable; shared limit unavailable'
          : `org-attributed active footprint unavailable; shared limit ${formatNumber(productionApps.limit)}`,
    };
  }
  return {
    value:
      productionApps.limit === null
        ? `${formatNumber(productionApps.active)} active; shared limit unavailable`
        : `${formatNumber(productionApps.active)} active / ${formatNumber(productionApps.limit)} shared limit`,
    note: 'org-attributed active apps; the account limit is shared across linked organizations',
  };
}

export function accountMeteringDetail(metering: AccountMeteringView): DisplayValue {
  if (metering.state === 'not_started') {
    return { value: 'Not started', note: 'Usage unavailable' };
  }
  if (metering.state === 'unavailable') {
    return {
      value: 'Usage reporting unavailable',
      note: 'no observed usage or quota balance is available',
    };
  }
  if (metering.mode === 'authoritative') {
    return {
      value: `${formatNumber(metering.usedMcpCalls)} used; ${formatNumber(metering.remainingMcpCalls)} remaining`,
      note: `Authoritative complete usage since ${day(metering.countingSince)}; resets ${day(metering.resetAt)}`,
    };
  }
  return {
    value: `${formatNumber(metering.observedCalls)} observed`,
    note: `Shadow observation with ${coverageLabel(metering)}; not enforcement or a quota balance`,
  };
}

export function orgMeteringDetail(metering: OrgMeteringView): DisplayValue {
  if (metering.state === 'not_started') {
    return { value: 'Not started', note: 'Usage unavailable' };
  }
  if (metering.state === 'unavailable') {
    return {
      value: 'Usage reporting unavailable',
      note: 'no org-attributed observation or quota balance is available',
    };
  }
  if (metering.mode === 'authoritative') {
    return {
      value: `${formatNumber(metering.attributedMcpCalls)} attributed`,
      note: `Authoritative org attribution since ${day(metering.countingSince)}; the pooled balance is visible only to billing account members`,
    };
  }
  return {
    value: `${formatNumber(metering.observedCalls)} observed`,
    note: `Org-attributed shadow observation with ${coverageLabel(metering)}; not enforcement or a quota balance`,
  };
}

export function enforcementDetail(enforcement: EnforcementView): DisplayValue {
  if (enforcement.state === 'active') {
    return {
      value: 'Active',
      note: 'Authoritative usage and production app limits are enforced',
    };
  }
  if (enforcement.state === 'exempt') {
    return {
      value: 'Exempt',
      note: 'Legacy internal account; commercial limits are not enforced',
    };
  }
  if (enforcement.state === 'unavailable') {
    return {
      value: 'Unavailable',
      note: 'Authoritative enforcement state cannot be confirmed',
    };
  }
  if (enforcement.state === 'inactive') {
    return enforcement.reason === 'rolled_back'
      ? {
          value: 'Rolled back',
          note: 'Commercial enforcement is disabled; authoritative evidence is preserved',
        }
      : {
          value: 'Not active',
          note: 'Authoritative commercial enforcement has not been activated',
        };
  }
  return {
    value: 'Legacy unchanged',
    note: 'Authoritative enforcement has not been activated',
  };
}

function coverageLabel(metering: {
  readonly coverage: 'partial';
  readonly observedSince: string;
}): string {
  return `partial coverage since ${metering.observedSince.slice(0, 10)}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function day(value: string): string {
  return value.slice(0, 10);
}
