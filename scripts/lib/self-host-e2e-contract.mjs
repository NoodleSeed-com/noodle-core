import { createHash } from 'node:crypto';
import { acceptanceRequestSignal } from './self-host-e2e-mcp.mjs';

const SELF_HOST_ORIGIN = 'http://127.0.0.1:8787';
const MAX_WIDGET_ASSET_BYTES = 10 * 1024 * 1024;

export function parseCliJson(output) {
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error('CLI output was not one JSON envelope');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CLI output was not one JSON envelope');
  }
  if (parsed.ok === false) {
    const code =
      parsed.error !== null &&
      typeof parsed.error === 'object' &&
      typeof parsed.error.code === 'string'
        ? parsed.error.code
        : 'unknown';
    throw new Error(`CLI command failed: ${code}`);
  }
  if (parsed.ok !== true || !('data' in parsed)) {
    throw new Error('CLI output was not one successful JSON envelope');
  }
  return parsed.data;
}

export function requireString(record, key, context) {
  if (record === null || typeof record !== 'object' || typeof record[key] !== 'string') {
    throw new Error(`${context} did not contain ${key}`);
  }
  return record[key];
}

export function deploymentResult(stdout, context, expected, seenDeploymentIds) {
  const value = parseCliJson(stdout);
  const result = {
    deploymentId: requireString(value, 'deploymentId', context),
    serverVersion: requireString(value, 'serverVersion', context),
    url: requireString(value, 'url', context),
    defaultUrl: requireString(value, 'defaultUrl', context),
  };
  if (
    result.serverVersion !== expected.version ||
    result.url !== `${SELF_HOST_ORIGIN}/o/noodle-local/${expected.app}/v${expected.version}/mcp` ||
    result.defaultUrl !== `${SELF_HOST_ORIGIN}/o/noodle-local/${expected.app}/mcp`
  ) {
    throw new Error(`${context} did not return the exact public endpoint contract`);
  }
  if (seenDeploymentIds.has(result.deploymentId)) {
    throw new Error(`${context} reused deploymentId ${result.deploymentId}`);
  }
  seenDeploymentIds.add(result.deploymentId);
  return result;
}

export function assertExactComposeServices(output) {
  const names = output.trim().split(/\s+/).filter(Boolean).sort();
  const expected = ['bootstrap', 'cli', 'noodle', 'postgres'];
  if (names.join('\n') !== expected.join('\n')) {
    throw new Error('rendered Compose config did not contain the exact public service set');
  }
  return names;
}

export function assertLiveNonRootUid(output, service) {
  const candidate = output.trim();
  if (!/^[0-9]+$/.test(candidate)) {
    throw new Error(`${service} did not report one numeric non-root UID`);
  }
  const uid = Number(candidate);
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error(`${service} did not report one numeric non-root UID`);
  }
  return uid;
}

export function assertRecoveredDeployment(stdout, expected) {
  const deployment = parseCliJson(stdout);
  if (
    requireString(deployment, 'deploymentId', expected.context) !== expected.deploymentId ||
    requireString(deployment, 'appSlug', expected.context) !== expected.app ||
    requireString(deployment, 'environment', expected.context) !== 'prod' ||
    requireString(deployment, 'serverVersion', expected.context) !== expected.version ||
    requireString(deployment, 'endpointUrl', expected.context) !== expected.url ||
    deployment.active !== expected.active
  ) {
    throw new Error(`${expected.context} did not preserve the exact deployment record`);
  }
}

export function assertDeploymentPackage(stdout, expected, expectedApp) {
  const value = parseCliJson(stdout);
  if (
    requireString(value, 'deploymentId', 'widget deployment package') !== expected.deploymentId ||
    requireString(value, 'appSlug', 'widget deployment package') !== expectedApp ||
    requireString(value, 'environment', 'widget deployment package') !== 'prod' ||
    requireString(value, 'serverVersion', 'widget deployment package') !== '1' ||
    !Array.isArray(value?.snapshot?.files) ||
    value.snapshot.files.length === 0
  ) {
    throw new Error('widget deployment package did not preserve its typed snapshot');
  }
}

export function hostedAssetUrl(resource) {
  const pending = [resource];
  let match;
  while (pending.length > 0 && match === undefined) {
    const value = pending.pop();
    if (typeof value === 'string') {
      match = /https?:\/\/[^"'<>\s]+\/__noodle\/hosted-assets\/[^"'<>\s]+/.exec(value)?.[0];
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value !== null && typeof value === 'object') {
      pending.push(...Object.values(value));
    }
  }
  if (match === undefined) throw new Error('widget resource did not contain a hosted asset URL');
  const parsed = new URL(match);
  if (
    parsed.origin !== SELF_HOST_ORIGIN ||
    !/^\/__noodle\/hosted-assets\/[a-f0-9]{16}\/[a-f0-9]{16}\/[a-f0-9]{16}\/[a-f0-9]{64}\/[A-Za-z0-9_-]{1,128}$/.test(
      parsed.pathname,
    ) ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error('widget resource did not use the exact local hosted-asset origin');
  }
  return parsed.toString();
}

async function readBoundedAsset(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_WIDGET_ASSET_BYTES)) {
    await response.body?.cancel();
    throw new Error('hosted asset exceeded the 10 MiB acceptance bound');
  }
  if (response.body === null) throw new Error('hosted asset body was unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_WIDGET_ASSET_BYTES) {
      await reader.cancel();
      throw new Error('hosted asset exceeded the 10 MiB acceptance bound');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

export async function fetchAsset(fetchImpl, url, signal) {
  const [get, head] = await Promise.all([
    fetchImpl(url, { signal: acceptanceRequestSignal(signal) }),
    fetchImpl(url, { method: 'HEAD', signal: acceptanceRequestSignal(signal) }),
  ]);
  if (!get.ok || !head.ok) throw new Error('hosted asset GET/HEAD failed');
  const bytes = await readBoundedAsset(get);
  if (bytes.byteLength === 0) throw new Error('hosted asset was empty');
  const etag = get.headers.get('etag');
  if (etag === null || head.headers.get('etag') !== etag) {
    throw new Error('hosted asset GET/HEAD ETag did not match');
  }
  if (get.headers.get('x-content-type-options') !== 'nosniff') {
    throw new Error('hosted asset omitted nosniff');
  }
  const contentType = get.headers.get('content-type');
  if (!/^image\/jpeg(?:\s*;|$)/i.test(contentType ?? '')) {
    throw new Error('hosted asset was not the Food Ordering image');
  }
  if (head.headers.get('content-type') !== contentType) {
    throw new Error('hosted asset GET/HEAD content type did not match');
  }
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    etag,
    contentType,
  };
}

export function assertSameAsset(before, after) {
  if (
    before.sha256 !== after.sha256 ||
    before.etag !== after.etag ||
    before.contentType !== after.contentType
  ) {
    throw new Error('hosted asset changed across retained-volume restart');
  }
}
