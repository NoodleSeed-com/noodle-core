import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { lstat, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const PROJECT_NAME_PATTERN = /^noodle-e2e-[a-z0-9]{8,32}$/;
const MAX_SAFE_TAIL_BYTES = 8 * 1024;
const MAX_SAFE_TAIL_LINES = 40;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

export function assertSelfHostProjectName(candidate) {
  if (!PROJECT_NAME_PATTERN.test(candidate)) {
    throw new Error('invalid self-host E2E Compose project name');
  }
  return candidate;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function assertSelfHostRootAvailable(root) {
  let rootPackage;
  try {
    rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    throw new Error('self-host E2E must run from a materialized Noodle Core tree');
  }
  if (rootPackage?.name !== 'noodle-core') {
    throw new Error('self-host E2E must run from a materialized Noodle Core tree');
  }
  const ownedPaths = [join(root, '.self-host'), join(root, 'noodle.service.yaml')];
  if ((await Promise.all(ownedPaths.map(pathExists))).some(Boolean)) {
    throw new Error('self-host E2E requires a checkout without existing operator state');
  }
}

function replaceLiteral(value, secret) {
  if (secret.length === 0) return value;
  return value.split(secret).join('[REDACTED]');
}

export function redactSensitiveOutput(output, generatedSecrets = []) {
  let safe = String(output);
  for (const secret of generatedSecrets) safe = replaceLiteral(safe, secret);
  return safe
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/^(\s*authorization\s*:\s*).+$/gim, '$1[REDACTED]')
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_DATABASE_URL]')
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|MASTER_KEY|IDENTITY_SALT|DATABASE_URL)[A-Z0-9_]*)=([^\s]*)/gi,
      '$1=[REDACTED]',
    );
}

const SENSITIVE_VALUE_FLAGS = new Set([
  '--auth-token',
  '--token',
  '--password',
  '--secret',
  '--database-url',
]);

function renderArgument(argument) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

export function renderSafeCommand(command, args) {
  const safe = [];
  let redactNext = false;
  for (const argument of args) {
    if (redactNext) {
      safe.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    if (SENSITIVE_VALUE_FLAGS.has(argument)) {
      safe.push(argument);
      redactNext = true;
      continue;
    }
    const assignment =
      /^([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|MASTER_KEY|IDENTITY_SALT|DATABASE_URL))=(.*)$/i.exec(
        argument,
      );
    safe.push(assignment === null ? renderArgument(argument) : `${assignment[1]}=[REDACTED]`);
  }
  return [command, ...safe].join(' ');
}

function boundedTail(value) {
  const lines = value.split(/\r?\n/).slice(-MAX_SAFE_TAIL_LINES).join('\n');
  return lines.length <= MAX_SAFE_TAIL_BYTES ? lines : lines.slice(-MAX_SAFE_TAIL_BYTES);
}

export class SelfHostE2EFailure extends Error {
  constructor(stage, summary, rawTail = '', generatedSecrets = []) {
    super(`self-host E2E failed at ${stage}: ${summary}`);
    this.name = 'SelfHostE2EFailure';
    this.stage = stage;
    this.safeTail = boundedTail(redactSensitiveOutput(rawTail, generatedSecrets));
  }
}

function stageFailure(stage, error) {
  if (error instanceof SelfHostE2EFailure) return error;
  return new SelfHostE2EFailure(stage, error instanceof Error ? error.message : String(error));
}

export async function runAcceptanceStages(stages, cleanup) {
  const results = [];
  let failure;
  try {
    for (const stage of stages) {
      try {
        const result = await stage.run();
        results.push({ name: stage.name, ...(result ?? {}) });
      } catch (error) {
        failure = stageFailure(stage.name, error);
        break;
      }
    }
  } finally {
    try {
      await cleanup();
      results.push({ name: 'cleanup' });
    } catch (error) {
      if (failure === undefined) {
        failure = stageFailure('cleanup', error);
      } else {
        failure.message +=
          '; cleanup also failed—remove the reported exact Compose project before retrying';
        failure.cleanupFailed = true;
      }
    }
  }
  if (failure !== undefined) throw failure;
  return results;
}

function appendBounded(current, chunk) {
  const combined = current + chunk.toString('utf8');
  if (Buffer.byteLength(combined, 'utf8') <= MAX_PROCESS_OUTPUT_BYTES) return combined;
  return Buffer.from(combined, 'utf8').subarray(-MAX_PROCESS_OUTPUT_BYTES).toString('utf8');
}

function terminateChildProcess(child, signal, detached) {
  if (detached && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the decision and the signal. Fall back to the direct PID.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // `close`/`error` remains the authoritative settlement path.
  }
}

function detachedProcessGroupIsAlive(child, detached) {
  if (!detached || !Number.isInteger(child.pid)) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function subprocessEnvironment(parent, overrides = {}) {
  const environment = { ...parent, ...overrides };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('COMPOSE_')) delete environment[key];
  }
  return environment;
}

function ownedArtifactPath(cwd, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error('maintenance artifact path must be a non-empty relative path');
  }
  const target = resolve(cwd, candidate);
  const fromRoot = relative(resolve(cwd), target);
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error('maintenance artifact path must stay inside the acceptance root');
  }
  return target;
}

export function createProcessRunner(options = {}) {
  const spawnImpl = options.spawn ?? spawn;
  const forceKillAfterMs = options.forceKillAfterMs ?? 5_000;
  const detached = options.detached ?? process.platform !== 'win32';
  const terminate =
    options.terminate ?? ((child, signal) => terminateChildProcess(child, signal, detached));
  const environment = options.environment ?? process.env;
  return {
    run(input) {
      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let terminationReason;
        let settled = false;
        let forceKillTimer;
        let forceKillCompleted = false;
        let pendingClose;
        if (input.signal?.aborted) {
          reject(new SelfHostE2EFailure(input.stage, 'command was interrupted'));
          return;
        }
        let stdinFd;
        let stdoutFd;
        let descriptorsClosed = false;
        const closeDescriptors = () => {
          if (descriptorsClosed) return;
          descriptorsClosed = true;
          if (stdinFd !== undefined) closeSync(stdinFd);
          if (stdoutFd !== undefined) closeSync(stdoutFd);
        };
        let child;
        try {
          if (input.stdinFile !== undefined) {
            stdinFd = openSync(ownedArtifactPath(input.cwd, input.stdinFile), 'r');
          }
          if (input.stdoutFile !== undefined) {
            stdoutFd = openSync(ownedArtifactPath(input.cwd, input.stdoutFile), 'wx', 0o600);
          }
          child = spawnImpl(input.command, input.args, {
            cwd: input.cwd,
            env: subprocessEnvironment(environment, input.env),
            detached,
            stdio: [stdinFd ?? 'ignore', stdoutFd ?? 'pipe', 'pipe'],
          });
        } catch (error) {
          closeDescriptors();
          reject(
            new SelfHostE2EFailure(
              input.stage,
              `could not prepare ${input.command}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          return;
        }
        const beginTermination = (reason) => {
          if (terminationReason !== undefined) return;
          terminationReason = reason;
          terminate(child, 'SIGTERM');
          forceKillTimer = setTimeout(() => {
            terminate(child, 'SIGKILL');
            forceKillCompleted = true;
            if (pendingClose !== undefined) finishClose(...pendingClose);
          }, forceKillAfterMs);
        };
        const onAbort = () => beginTermination('interrupt');
        input.signal?.addEventListener('abort', onAbort, { once: true });
        if (input.signal?.aborted) onAbort();
        const timer = setTimeout(() => beginTermination('timeout'), input.timeoutMs);
        timer.unref?.();
        child.stdout?.on('data', (chunk) => {
          outputBytes += chunk.byteLength;
          stdout = appendBounded(stdout, chunk);
          if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) beginTermination('output');
        });
        child.stderr?.on('data', (chunk) => {
          outputBytes += chunk.byteLength;
          stderr = appendBounded(stderr, chunk);
          if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) beginTermination('output');
        });
        child.once('error', (error) => {
          if (settled) return;
          settled = true;
          closeDescriptors();
          clearTimeout(timer);
          clearTimeout(forceKillTimer);
          input.signal?.removeEventListener('abort', onAbort);
          reject(
            new SelfHostE2EFailure(
              input.stage,
              `could not start ${input.command}: ${error.message}`,
              `${stdout}\n${stderr}`,
              input.generatedSecrets,
            ),
          );
        });
        const finishClose = (code, signal) => {
          if (settled) return;
          settled = true;
          closeDescriptors();
          clearTimeout(timer);
          clearTimeout(forceKillTimer);
          input.signal?.removeEventListener('abort', onAbort);
          const output = `${stdout}\n${stderr}`.trim();
          if (terminationReason === 'timeout') {
            reject(
              new SelfHostE2EFailure(
                input.stage,
                `command timed out after ${input.timeoutMs}ms`,
                output,
                input.generatedSecrets,
              ),
            );
          } else if (terminationReason === 'interrupt') {
            reject(
              new SelfHostE2EFailure(
                input.stage,
                'command was interrupted',
                output,
                input.generatedSecrets,
              ),
            );
          } else if (terminationReason === 'output') {
            reject(
              new SelfHostE2EFailure(
                input.stage,
                'command output exceeded the 4 MiB acceptance bound',
                output,
                input.generatedSecrets,
              ),
            );
          } else if (signal !== null) {
            reject(
              new SelfHostE2EFailure(
                input.stage,
                `command terminated by signal ${signal}`,
                output,
                input.generatedSecrets,
              ),
            );
          } else if (code !== 0) {
            reject(
              new SelfHostE2EFailure(
                input.stage,
                `command exited with code ${String(code)}`,
                output,
                input.generatedSecrets,
              ),
            );
          } else {
            resolve({
              code: 0,
              stdout,
              stderr,
              display: renderSafeCommand(input.command, input.args),
            });
          }
        };
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          if (
            terminationReason !== undefined &&
            !forceKillCompleted &&
            detachedProcessGroupIsAlive(child, detached)
          ) {
            pendingClose = [code, signal];
            return;
          }
          finishClose(code, signal);
        });
      });
    },
  };
}

export function assertContainerHardening(output, projectName) {
  const containers = output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [
        user,
        readOnly,
        privileged,
        capAdd,
        capabilities,
        security,
        networkMode,
        tmpfs,
        ports,
        mounts,
        ...extra
      ] = line.split('\t');
      if (
        user === undefined ||
        readOnly === undefined ||
        privileged === undefined ||
        capAdd === undefined ||
        capabilities === undefined ||
        security === undefined ||
        networkMode === undefined ||
        tmpfs === undefined ||
        ports === undefined ||
        mounts === undefined ||
        extra.length > 0
      ) {
        throw new Error('docker inspect did not return the bounded hardening fields');
      }
      try {
        return {
          user,
          readOnly: JSON.parse(readOnly),
          privileged: JSON.parse(privileged),
          capAdd: JSON.parse(capAdd),
          capabilities: JSON.parse(capabilities),
          security: JSON.parse(security),
          networkMode,
          tmpfs: JSON.parse(tmpfs),
          ports: JSON.parse(ports),
          mounts: JSON.parse(mounts),
        };
      } catch {
        throw new Error('docker inspect returned invalid hardening JSON');
      }
    });
  if (containers.length !== 2)
    throw new Error('docker inspect did not return both runtime containers');
  for (const container of containers) {
    const { user } = container;
    if (typeof user !== 'string' || user.length === 0 || user === 'root' || user === '0') {
      throw new Error('self-host container did not run as an explicit non-root user');
    }
    if (
      container.readOnly !== true ||
      container.privileged !== false ||
      (container.capAdd !== null &&
        (!Array.isArray(container.capAdd) || container.capAdd.length > 0)) ||
      !Array.isArray(container.capabilities) ||
      container.capabilities.length !== 1 ||
      container.capabilities[0] !== 'ALL' ||
      !Array.isArray(container.security) ||
      container.security.length !== 1 ||
      container.security[0] !== 'no-new-privileges:true'
    ) {
      throw new Error('self-host container hardening did not match the public contract');
    }
    if (container.networkMode !== `${projectName}_default`) {
      throw new Error('self-host container did not use its exact private Compose network');
    }
  }
  const [postgres, noodle] = containers;
  const boundedTmpfs = (container, expected) => {
    if (
      container.tmpfs === null ||
      typeof container.tmpfs !== 'object' ||
      Array.isArray(container.tmpfs) ||
      Object.keys(container.tmpfs).sort().join('\n') !== Object.keys(expected).sort().join('\n')
    ) {
      return false;
    }
    for (const [path, alternatives] of Object.entries(expected)) {
      const options = container.tmpfs[path];
      if (typeof options !== 'string') return false;
      const tokens = options.split(',');
      const values = new Set(tokens);
      if (
        values.size !== tokens.length ||
        !alternatives.some(
          (allowed) =>
            allowed.length === tokens.length && allowed.every((token) => values.has(token)),
        )
      ) {
        return false;
      }
    }
    return true;
  };
  if (
    !boundedTmpfs(postgres, {
      '/tmp': [
        ['rw', 'noexec', 'nosuid', 'size=67108864'],
        ['rw', 'noexec', 'nosuid', 'size=64m'],
      ],
      '/var/run/postgresql': [
        ['rw', 'noexec', 'nosuid', 'size=16777216', 'uid=999', 'gid=999', 'mode=0775'],
        ['rw', 'noexec', 'nosuid', 'size=16m', 'uid=999', 'gid=999', 'mode=0775'],
      ],
    }) ||
    !boundedTmpfs(noodle, {
      '/tmp': [
        ['rw', 'noexec', 'nosuid', 'size=67108864'],
        ['rw', 'noexec', 'nosuid', 'size=64m'],
      ],
    })
  ) {
    throw new Error('self-host temporary filesystems are not bounded and hardened');
  }
  if (Object.keys(postgres.ports ?? {}).length !== 0) {
    throw new Error('PostgreSQL unexpectedly publishes a host port');
  }
  const noodleBindings = noodle.ports?.['8787/tcp'];
  if (
    Object.keys(noodle.ports ?? {}).length !== 1 ||
    !Array.isArray(noodleBindings) ||
    noodleBindings.length !== 1 ||
    noodleBindings[0]?.HostIp !== '127.0.0.1' ||
    noodleBindings[0]?.HostPort !== '8787'
  ) {
    throw new Error('Noodle is not published only on loopback port 8787');
  }
  const exactOwnedMounts = (container, volumeName, destination, tmpfsDestinations) => {
    if (!Array.isArray(container.mounts)) return false;
    let ownedVolumeCount = 0;
    for (const mount of container.mounts) {
      if (
        mount?.Type === 'volume' &&
        mount.Name === volumeName &&
        mount.Destination === destination
      ) {
        ownedVolumeCount += 1;
      } else if (!(mount?.Type === 'tmpfs' && tmpfsDestinations.has(mount.Destination))) {
        return false;
      }
    }
    return ownedVolumeCount === 1;
  };
  if (
    !exactOwnedMounts(
      postgres,
      `${projectName}_postgres-data`,
      '/var/lib/postgresql/data',
      new Set(['/tmp', '/var/run/postgresql']),
    ) ||
    !exactOwnedMounts(
      noodle,
      `${projectName}_asset-data`,
      '/var/lib/noodle/assets',
      new Set(['/tmp']),
    )
  ) {
    throw new Error('self-host persistence volumes are not mounted at their owned paths');
  }
}

export function composeArguments(projectName, ...args) {
  return [
    'compose',
    '--file',
    'compose.yaml',
    '--project-name',
    projectName,
    '--profile',
    'tools',
    ...args,
  ];
}

export function cliArguments(projectName, ...args) {
  return composeArguments(projectName, 'run', '--rm', '--no-deps', 'cli', ...args);
}

export function createExactProjectCleanup(input) {
  if (input.dockerPath !== undefined && !isAbsolute(input.dockerPath)) {
    throw new Error('self-host E2E cleanup requires an absolute Docker path when one is provided');
  }
  const projectName = assertSelfHostProjectName(input.projectName);
  const dockerCommand = input.dockerPath ?? 'docker';
  let cleanupPromise;
  return () => {
    cleanupPromise ??= (async () => {
      try {
        await input.runner.run({
          stage: 'cleanup',
          command: dockerCommand,
          args: composeArguments(projectName, 'down', '--volumes', '--remove-orphans'),
          cwd: input.root,
          timeoutMs: 120_000,
          generatedSecrets: [],
        });
      } finally {
        if (input.removeGeneratedState === true) {
          await rm(join(input.root, '.self-host'), { recursive: true, force: true });
          await rm(join(input.root, 'noodle.service.yaml'), { force: true });
        }
      }
    })();
    return cleanupPromise;
  };
}
