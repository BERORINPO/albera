# ADR-011 — Physical Machine Provider (owner-supplied computers over SSH)

- **Status:** Proposed (security review required)
- **Date:** 2026-10-30
- **Depends on:** ADR-001 (Provider), ADR-002 (Trust), ADR-004 (Images), ADR-005 (Pool), ADR-007 (Verification), ADR-009 (Drivers)
- **Scope:** adding real, owner-supplied machines (for example a shelf of mini PCs) as ALBERA computers. Design only; nothing here is implemented.

## Context
Some users already own many physical machines and want ALBERA's AI to work on them the way it works on Hyper-V VMs: watch the screen, move the mouse, type. ADR-001 already separates the Environment Provider from the domain model and names "remote" providers, so a new provider fits the contract. A physical machine still differs from a VM in ways that change the safety model:

1. **No lifecycle reset.** There is no create, destroy, checkpoint or restore. A machine cannot be returned to a clean image by ALBERA, so ADR-001 §6 (re-provision instead of sanitizing) and ADR-004 cannot be applied.
2. **No host side.** On Hyper-V, screen and input go through host-side synthetic devices so that software inside the guest cannot take over the controller (decision log `2026-10-29+hyperv-desktop`). A physical machine has no such outside position; capture and input must run inside the machine.
3. **Real contents.** A machine may hold accounts, keys and data unrelated to ALBERA, for example a box that also serves as a deployment or merge host for another system. Screen control there lets the AI reach those credentials. Dedication cannot be inferred; it has to be declared and checked.
4. **No egress control.** ALBERA cannot enforce the network profile of ADR-002 on a machine it does not host.

The 2026-10-30 guest-capture work (`spec/architecture.md`, `2026-10-30+guest-capture`) showed that a small helper started as an *Interactive* scheduled task can capture the logged-in desktop. That transport was PowerShell Direct; on a physical machine the same helper can be started over SSH.

## Decision
1. **New provider `physical-ssh`.** Supported operations: `inspect`, `stop` (OS shutdown), optional `start` (Wake-on-LAN, only if configured). `create`, `destroy`, `checkpoint` and `restore` are declared **unsupported** in capabilities, never emulated.
2. **Role restriction (hard filter in ADR-005).** A physical machine may only serve the `persistent` role, bound to exactly one project. It is never placed as `ephemeral` or `verification`, and never reused across projects. Moving a machine to another project requires the owner to reimage it and enroll it again, which yields a new `computerId`.
3. **Owner enrollment.** Only the machine owner enrolls a machine, through an explicit, authenticated Control API command. Enrollment records:
   - the SSH host key, pinned at enrollment after the owner confirms its fingerprint; a changed host key quarantines the computer;
   - a per-machine ed25519 client key held by the Host Broker, installed with `restrict` in `authorized_keys` (no agent, port or X11 forwarding, no PTY unless the terminal driver is granted);
   - the owner's **dedication declaration**: a dedicated standard (non-admin) local account for ALBERA, no personal sign-ins, no credentials or keys for other systems, not used as infrastructure for anything else. This is a human claim, not proof; the UI must show it as declared, and enrollment must warn on observable violations (other interactive users signed in, membership in Administrators, known credential stores present).
4. **In-machine interaction driver.** Capture reuses the guest-capture helper. Input adds a helper that injects mouse and keyboard events in the same session. Both run as an Interactive scheduled task of the dedicated account and are started over SSH. This is a deliberate exception to `2026-10-29+hyperv-desktop`, limited to `physical-ssh`: software on the machine can forge frames or ignore input. Consequently frames and input acknowledgements are **claims** (ADR-002), and a DONE claim is verified on a separate `verification` computer per ADR-007, never on the physical machine itself.
5. **Coordinates.** The driver reports the real desktop size and display scale with every frame. The model sees a normalized frame; the driver maps coordinates back. Multi-monitor machines expose one chosen display only in v1.
6. **Unreachable desktops.** The sign-in screen, lock screen and UAC secure desktop cannot be captured or driven from the user session. The driver reports `desktop_unavailable` and stops; ALBERA does not store sign-in passwords or configure auto-logon. Getting the dedicated account signed in is the owner's job.
7. **Attended first.** Physical machines start in attended mode: a human holds the ADR-009 control lease and can take over at any time; the actions ADR-009 names (credentials, external posting, financial, destructive) always need host-mediated approval. Unattended operation on a physical machine is a later, separate decision.
8. **Capabilities are explicit.** `isolation: "none"` and `egressControl: "none"` are reported, and the scheduler never places a task that requires `isolation=vm` or controlled egress on a physical machine (ADR-001: never downgrade silently).

## Contract sketch (conceptual; not current implementation)
```ts
type PhysicalSshCapabilities = ProviderCapabilities & {
  providerKind: 'physical-ssh';
  lifecycle: { create: false; destroy: false; checkpoint: false; restore: false; start: 'wol' | false };
  isolation: 'none';
  egressControl: 'none';
  roles: ['persistent'];
  desktop: { width: number; height: number; scale: number; display: string } | 'unavailable';
};

type PhysicalEnrollment = {
  computerId: ComputerId;          // new on every enrollment
  projectId: string;               // exactly one
  hostKeyFingerprint: string;      // pinned; mismatch => QUARANTINED
  clientKeyRef: string;            // Host Broker secret reference, never sent to Canvas
  dedication: { declaredBy: string; declaredAt: string; warnings: string[] };
};
```

## Alternatives considered
| Alternative | Assessment |
|---|---|
| Treat a physical machine like a VM | Rejected: no reset, no host side, no egress control. |
| RDP | Rejected for v1: a session takes over or locks the console, so the owner cannot watch the same screen. |
| VNC server on each machine | Deferred: adds a third-party server and its password model; may become a second driver later. |
| In-machine agent listening on an inbound port | Rejected: opens a new listening surface on every machine; SSH already exists and is pinned. |
| Relay through an ALBERA cloud server | Deferred: the paid team server does not host or route computers yet (product decision 2026-10-29). |
| Enroll any machine the AI can reach | Rejected: enrollment is an owner act, never an agent act. |

## Verification gates
1. Fake provider contract suite: unsupported operations fail with a typed error; the scheduler property test never places `physical-ssh` as `ephemeral` or `verification` or across projects.
2. Enrollment negatives: changed host key, missing `restrict`, forwarding attempt, second project binding and non-owner enrollment are all refused.
3. One real machine, attended: capture, click and type on the dedicated account; `desktop_unavailable` on the lock screen; a DONE claim verified on a separate VM.
4. Coordinate mapping on at least two display sizes and one scale other than 100 %.

## Consequences / open questions
+ Users with existing hardware can use ALBERA without Hyper-V capacity.
+ Reuses the guest-capture helper and the ADR-001 provider seam.
− Weaker isolation than VMs; safety depends partly on the owner's dedication declaration.
− No rollback: a mistake on a physical machine is not undone by ALBERA.

Open: Linux and macOS machines; Wake-on-LAN and remote power; automated reimaging (PXE); fleet enrollment in bulk; how many machines one Host Broker can hold open SSH sessions to.

**Decision gate:** do not mark `Accepted` until security review and verification gates 1–3 pass.
