import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { startProcess, stopProcess } from '../../../scripts/e2e/solutions-harness.mjs';

describe('Solutions acceptance owned process cleanup', () => {
  it.each([
    false,
    true,
  ])('closes inherited pipes and terminates descendants when the launcher already exited: %s', async (launcherExitsFirst) => {
    const descendant = `
        const server = require('node:http').createServer((request, response) => response.end('alive'));
        ${launcherExitsFirst ? '' : "process.on('SIGTERM', () => {});"}
        server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
      `;
    const launcher = `
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
          { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        child.once('message', message => {
          process.send({ ...message, pid: child.pid }, () => {
            ${launcherExitsFirst ? 'process.exit(0);' : ''}
          });
        });
        process.on('SIGTERM', () => process.exit(0));
      `;
    const handle = startProcess(process.execPath, ['-e', launcher], { ipc: true });
    const exited = once(handle.child, 'exit');
    let descendantPid: number | undefined;
    let closed = false;
    handle.child.once('close', () => {
      closed = true;
    });
    try {
      const [ready] = await once(handle.child, 'message');
      descendantPid = ready.pid;
      expect((await fetch(`http://127.0.0.1:${ready.port}`)).status).toBe(200);
      if (launcherExitsFirst) await exited;

      await stopProcess(handle);

      expect(closed, 'launcher exit must not leave inherited output pipes open').toBe(true);
      await expect(fetch(`http://127.0.0.1:${ready.port}`)).rejects.toThrow();
      await stopProcess(handle);
    } finally {
      // The failing-first implementation leaves a live grandchild; never leak test-owned work.
      if (descendantPid !== undefined) {
        killOwnedPid(descendantPid);
      }
      if (handle.child.exitCode === null && handle.child.signalCode === null)
        handle.child.kill('SIGKILL');
    }
  }, 10_000);
});

function killOwnedPid(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
