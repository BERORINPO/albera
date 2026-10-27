// Composition root for the separate ALBERA Runtime process and its trusted approval UI.
import { randomBytes } from 'node:crypto';
import { createRuntimeApi } from './api.mjs';
import { createRuntimeApprovalBroker } from './approval-broker.mjs';
import { createRuntimeApprovalHost } from './approval-host.mjs';
import { RuntimeGateway } from './gateway.mjs';

/**
 * Build a separately hosted Runtime stack. It is deliberately not imported by the read-only Observer.
 * @param {{roots: string[], journal?: {append: Function, list: Function, close?: Function}, gatewayOptions?: object, hostOptions?: object}} options
 */
export function createRuntimeHost({ roots, journal, gatewayOptions = {}, hostOptions = {} } = {}) {
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('Runtime host requires at least one allowed project root');
  const runtimeSessionId = hostOptions.sessionId ?? createRuntimeSessionId();
  const broker = createRuntimeApprovalBroker();
  const gateway = new RuntimeGateway({ ...gatewayOptions, roots, authorize: broker.authorize });
  const api = createRuntimeApi({ gateway, journal, approvalBroker: broker });
  const approvalHost = createRuntimeApprovalHost({ api, roots, ...hostOptions, sessionId: runtimeSessionId });
  let closePromise;
  return Object.freeze({
    listen(port = 0) { return approvalHost.listen(port); },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await approvalHost.close({ closeApi: false });
        let uncertain = [];
        try {
          uncertain = await gateway.close();
          await api.flushEvents();
        } finally {
          await api.close();
          await approvalHost.drain();
          await journal?.close?.();
        }
        return uncertain;
      })();
      return closePromise;
    },
    get broker() { return broker; },
    get gateway() { return gateway; },
    get sessionId() { return runtimeSessionId; },
  });
}

// A non-secret journal identity lets a trusted host reissue the same API session if it persists this value.
export function createRuntimeSessionId() { return randomBytes(16).toString('hex'); }
