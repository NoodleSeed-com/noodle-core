import { describe, expect, it } from 'vitest';

import {
  capabilitiesForDeveloperResource,
  DEVELOPER_CLI_PATH,
  DEVELOPER_MCP_PATH,
  isDeveloperResource,
} from '../src/index.js';

describe('developer resource capabilities', () => {
  it('recognizes relative and absolute developer resource URLs', () => {
    expect(isDeveloperResource(DEVELOPER_MCP_PATH)).toBe(true);
    expect(isDeveloperResource(`https://cloud.noodleseed.dev${DEVELOPER_MCP_PATH}/`)).toBe(true);
    expect(isDeveloperResource(DEVELOPER_CLI_PATH)).toBe(true);
    expect(isDeveloperResource('/v1/orgs/acme/apps')).toBe(false);
    expect(isDeveloperResource('not a URL')).toBe(false);
  });

  it('derives capabilities from the resource instead of caller input', () => {
    expect(capabilitiesForDeveloperResource(DEVELOPER_MCP_PATH)).toEqual([
      'cloud:read',
      'deployments:rollback',
    ]);
    // The CLI drives the whole local build/configure/deploy loop, so it alone carries config:write.
    expect(capabilitiesForDeveloperResource(DEVELOPER_CLI_PATH)).toEqual([
      'cloud:read',
      'deployments:write',
      'config:write',
    ]);
    expect(capabilitiesForDeveloperResource('/v1/apps')).toEqual([]);
  });
});
