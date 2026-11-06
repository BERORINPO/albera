// Plumbing for the WSL bridge tests (Windows-only .NET): build the bridge (with the test-only `trust-sid` seam) and the in-process harness into temp folders, run the harness, and make leases the way the Broker will
// (the Node twin, a throwaway ECDSA key). Nothing here installs, registers or elevates anything, and it never starts wsl.exe.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { createEcdsaAttestationSigner } from '../../src/runtime/ecdsa-attestation-signer.mjs';
import { createWsl2RunLease, signWsl2RunLease } from '../../src/runtime/broker-contract/wsl2-run-lease.mjs';
import { repositoryRoot } from './windows-broker-harness.mjs';

export { getUnavailableReason, repositoryRoot } from './windows-broker-harness.mjs';

export const bridgeDirectory = path.join(repositoryRoot, 'src', 'runtime', 'windows-wsl-bridge');
const harnessProject = path.join(repositoryRoot, 'test', 'wsl-bridge-harness', 'WslBridgeHarness.csproj');
const bridgeProject = path.join(bridgeDirectory, 'Albera.WslBridge.csproj');
const quiet = { encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 240_000 };

/** Build the bridge with the test seam on. Returns the `.exe` path. */
export function buildBridge(workDirectory) {
  const intermediate = `${path.join(workDirectory, 'bridge-obj')}${path.sep}`;
  const output = path.join(workDirectory, 'bridge');
  execFileSync('dotnet', ['build', bridgeProject, '--configuration', 'Release', '--output', output, '--property:AlberaWslBridgeTestSeams=true', `--property:BaseIntermediateOutputPath=${intermediate}`,
    `--property:MSBuildProjectExtensionsPath=${intermediate}`, '--nologo'], quiet);
  return path.join(output, 'albera-wsl-bridge.exe');
}

/** Build the in-process harness and run it: { checks: [{ name, ok, detail }] }. `probeFile` adds the interop check. */
export function runBridgeHarness(workDirectory, probeFile) {
  const intermediate = `${path.join(workDirectory, 'obj')}${path.sep}`;
  const output = path.join(workDirectory, 'out');
  execFileSync('dotnet', ['build', harnessProject, '--configuration', 'Release', '--output', output, `--property:BridgeDir=${bridgeDirectory}${path.sep}`,
    `--property:ContractDir=${path.join(repositoryRoot, 'src', 'runtime', 'broker-contract')}${path.sep}`, `--property:BaseIntermediateOutputPath=${intermediate}`,
    `--property:MSBuildProjectExtensionsPath=${intermediate}`, '--nologo'], quiet);
  const args = [path.join(output, 'WslBridgeHarness.dll'), ...(probeFile ? [probeFile] : [])];
  return JSON.parse(execFileSync('dotnet', args, { encoding: 'utf8', timeout: 240_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
}

/** A throwaway Broker key and a way to sign leases with the Node twin. The private key never leaves this object. */
export function makeLeaseKit(keyId = 'broker-test') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signer = createEcdsaAttestationSigner({ keyId, privateKey });
  return {
    keyId, spki: signer.publicKeySpki,
    /** @param {object} fields operationId, computerId, repositoryId, baseOid, plus optional maxCalls, ttlSeconds, issuedAt, leaseGeneration */
    async lease({ operationId, computerId, repositoryId, baseOid, maxCalls = 50, ttlSeconds = 600, issuedAt, leaseGeneration = 1 }) {
      const body = createWsl2RunLease({ operationId, actionDigest: `sha256:${'0'.repeat(64)}`, leaseGeneration, computerId, repositoryId, baseOid, maxCalls, issuedAt, ttlSeconds });
      return signWsl2RunLease(body, signer);
    },
  };
}
