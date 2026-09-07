import { parentPort, workerData } from 'node:worker_threads';
import {
  getQuickJS,
  newQuickJSAsyncWASMModule,
  type QuickJSAsyncWASMModule,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import { type ComputeAppLogEntry, ComputeError } from './engine.js';
import { runHosted, runPure, type SandboxHostBridge } from './sandbox-eval.js';
import type {
  MainToWorkerMessage,
  ResultMessage,
  RunMessage,
  WorkerToMainMessage,
} from './worker-messages.js';

/**
 * The compute pool's worker-thread entrypoint. Each worker executes one sandboxed invocation at a
 * time on its own QuickJS interpreter, so tenant compute consumes a worker thread — never the
 * service's main event loop. The WASM modules are loaded once per worker and every invocation still
 * gets a fresh, disposed QuickJS runtime, preserving per-invocation isolation.
 *
 * The `workerData` marker keeps this loop from arming when the module graph is loaded anywhere else
 * (the main thread, or a test runner's own worker threads).
 */

interface ComputeWorkerData {
  readonly noodleComputeWorker?: boolean;
}

if (parentPort !== null && (workerData as ComputeWorkerData | null)?.noodleComputeWorker === true) {
  startWorker(parentPort);
}

type ParentPort = NonNullable<typeof parentPort>;

function startWorker(port: ParentPort): void {
  let syncModule: Promise<QuickJSWASMModule> | undefined;
  let asyncModule: Promise<QuickJSAsyncWASMModule> | undefined;
  const pendingHostReplies = new Map<number, (envelopeJson: string) => void>();
  const pendingLogAcks = new Map<number, () => void>();
  let nextCallId = 0;

  const post = (message: WorkerToMainMessage): void => port.postMessage(message);

  port.on('message', (message: MainToWorkerMessage) => {
    if (message.t === 'run') {
      void handleRun(message);
      return;
    }
    if (message.t === 'host_result') {
      const resolve = pendingHostReplies.get(message.callId);
      pendingHostReplies.delete(message.callId);
      resolve?.(message.envelopeJson);
      return;
    }
    const ack = pendingLogAcks.get(message.callId);
    pendingLogAcks.delete(message.callId);
    ack?.();
  });

  function bridgeFor(run: RunMessage): SandboxHostBridge {
    return {
      callOperation: (name, argsJson) =>
        new Promise<string>((resolve) => {
          const callId = nextCallId;
          nextCallId += 1;
          pendingHostReplies.set(callId, resolve);
          post({ t: 'host_call', id: run.id, callId, name, argsJson });
        }),
      ...(run.consoleEnabled
        ? {
            log: (entry: ComputeAppLogEntry) =>
              new Promise<void>((resolve) => {
                const callId = nextCallId;
                nextCallId += 1;
                pendingLogAcks.set(callId, resolve);
                post({ t: 'log', id: run.id, callId, entry });
              }),
          }
        : {}),
    };
  }

  function loadSyncModule(): Promise<QuickJSWASMModule> {
    syncModule ??= getQuickJS();
    return syncModule;
  }

  function loadAsyncModule(): Promise<QuickJSAsyncWASMModule> {
    asyncModule ??= newQuickJSAsyncWASMModule();
    return asyncModule;
  }

  async function handleRun(run: RunMessage): Promise<void> {
    let outcome: ResultMessage['outcome'];
    try {
      const input: unknown = JSON.parse(run.inputJson);
      const outputJson = run.hostEnabled
        ? await runHosted(await loadAsyncModule(), run.source, input, run.limits, bridgeFor(run))
        : runPure(await loadSyncModule(), run.source, input, run.limits);
      outcome = { ok: true, outputJson };
    } catch (error) {
      const compute =
        error instanceof ComputeError
          ? error
          : new ComputeError('runtime_error', 'sandbox execution failed');
      outcome = {
        ok: false,
        error: {
          code: compute.code,
          message: compute.message,
          ...(compute.path === undefined ? {} : { path: compute.path }),
        },
      };
    } finally {
      pendingHostReplies.clear();
      pendingLogAcks.clear();
    }
    post({ t: 'result', id: run.id, outcome });
  }
}
