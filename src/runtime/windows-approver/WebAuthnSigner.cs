using System.Security.Cryptography;

namespace Albera.Approver;

// The WebAuthn side of presence (docs/architecture/approver-webauthn.md). IWebAuthnAuthenticator is the platform boundary: the shipped build implements it with webauthn.dll (WebAuthn.cs, PlatformWebAuthn);
// the test-faults build with an in-memory software authenticator (TestSeam.cs). Everything above it is shared code that the unit harness runs: the client data, the checks of what came back, the key record.
// A result is trusted for nothing: the credential must be one that was asked for, the authenticator data must satisfy the Authority's rule, and a created key must be a key the contract allows.

internal enum WebAuthnStatus { Ok, Cancelled, NotReady }

/// <param name="Detail">a short reason for the hint line (an HRESULT and the API's error name), never request text</param>
internal sealed record CreatedCredential(WebAuthnStatus Status, byte[]? CredentialId, byte[]? AuthenticatorData, string? Detail = null);

internal sealed record AssertionResult(WebAuthnStatus Status, byte[]? CredentialId, byte[]? AuthenticatorData, byte[]? Signature, string? Detail = null);

internal interface IWebAuthnAuthenticator
{
    /// <summary>Makes a new credential for <see cref="WebAuthnContract.RpId"/> on any authenticator the person picks: user verification required, attestation none. <paramref name="window"/> is the parent window (default: the console).</summary>
    CreatedCredential MakeCredential(IntPtr window, byte[] userId, byte[] clientDataJson);

    /// <summary>Signs the hash of <paramref name="clientDataJson"/> with one of the credentials named in <paramref name="allowCredentialIds"/>: user verification required.</summary>
    AssertionResult GetAssertion(IntPtr window, byte[] clientDataJson, IReadOnlyList<byte[]> allowCredentialIds);
}

/// <summary>What the commands need for WebAuthn: the authenticator, whether this is a remote session (SM_REMOTESESSION), and where the key record files go. Null in <see cref="Wiring"/> means "Hello only" (legacy and unit tests).</summary>
internal sealed record WebAuthnKit(IWebAuthnAuthenticator Authenticator, bool RemoteSession, KeyRecordStore Records);

internal sealed class WebAuthnSigner(IWebAuthnAuthenticator authenticator)
{
    /// <summary>
    /// Signs <paramref name="message"/> with a registered WebAuthn key. Signed only for an assertion that is for one of the credentials asked for, with authenticator data that passes the Authority's rule, and a non-empty signature of a sane size.
    /// A cancelled prompt is Unavailable (no proof). Anything else that did not produce a usable assertion is NotReady: nothing is sent.
    /// </summary>
    public SignResult Sign(byte[] message, IReadOnlyList<byte[]> allowCredentialIds, IntPtr window)
    {
        AssertionResult result;
        try { result = authenticator.GetAssertion(window, WebAuthnContract.ClientDataForAssertion(message), allowCredentialIds); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return SignResult.NotReady; } // the platform API itself is not usable here: nothing is sent
        if (result.Status == WebAuthnStatus.Cancelled) return SignResult.Unavailable;
        if (result.Status != WebAuthnStatus.Ok) return SignResult.NotReadyBecause(result.Detail ?? "no result");
        if (result.CredentialId is not { } credential || result.AuthenticatorData is not { } data || result.Signature is not { } signature) return SignResult.NotReadyBecause("incomplete result");
        if (!allowCredentialIds.Any(id => id.AsSpan().SequenceEqual(credential))) return SignResult.NotReadyBecause("a credential that was not asked for");
        if (!WebAuthnContract.IsPresenceAssertion(data)) return SignResult.NotReadyBecause("authenticator data does not satisfy the rule");
        if (signature.Length is < 1 or > WebAuthnContract.MaxSignatureBytes) return SignResult.NotReadyBecause("signature size");
        return SignResult.SignedWebAuthn(new WebAuthnAssertion(credential, data, signature));
    }
}

internal sealed record CreationResult(WebAuthnStatus Status, ApproverKeyRecord? Record, string? Detail);

/// <summary>Makes a credential and turns the answer into a key record. The user id is fresh random bytes, so every call makes a new credential and never replaces another one.</summary>
internal static class WebAuthnCreator
{
    public static CreationResult Create(IWebAuthnAuthenticator authenticator, IntPtr window)
    {
        CreatedCredential created;
        try
        {
            created = authenticator.MakeCredential(window, RandomNumberGenerator.GetBytes(WebAuthnContract.UserIdBytes), WebAuthnContract.ClientDataForCreation(RandomNumberGenerator.GetBytes(32)));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return new CreationResult(WebAuthnStatus.NotReady, null, "the platform API is not usable"); }
        if (created.Status != WebAuthnStatus.Ok) return new CreationResult(created.Status, null, created.Detail);
        if (created.CredentialId is not { } id || created.AuthenticatorData is not { } data) return new CreationResult(WebAuthnStatus.NotReady, null, "incomplete result");
        if (!WebAuthnContract.TryReadCreated(data, out byte[] embeddedId, out int alg, out byte[] spki) || !embeddedId.AsSpan().SequenceEqual(id))
            return new CreationResult(WebAuthnStatus.NotReady, null, "the new credential's data does not satisfy the contract");
        ApproverKeyRecord? record = ApproverKeyRecord.TryCreate(ApproverKeyRecord.WebAuthnKind, alg, spki, id);
        return record is null ? new CreationResult(WebAuthnStatus.NotReady, null, "the new key is not an ES256 or RS256 key the contract allows") : new CreationResult(WebAuthnStatus.Ok, record, null);
    }
}
