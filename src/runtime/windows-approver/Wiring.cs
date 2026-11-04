namespace Albera.Approver;

/// <summary>What the commands run against: the pipe server to expect, the Hello presence signer, the Hello key store, the per-call timeout, whether stdin is a console a person types in, and the WebAuthn kit (null = Hello only).</summary>
internal sealed record Wiring(ServerExpectation Expectation, IPresenceSigner Signer, IHelloKeyStore KeyStore, int TimeoutMs, bool Interactive, WebAuthnKit? WebAuthn = null);
