using System.Security.Cryptography;
using Windows.Security.Credentials;
using Windows.Security.Cryptography;
using Windows.Security.Cryptography.Core;

namespace Albera.Approver;

// Windows Hello through the WinRT KeyCredentialManager (the Windows SDK projection, NuGet package Microsoft.Windows.SDK.NET.Ref, pinned in the csproj). This file is in the shipped
// build ONLY: the test-faults build removes it, so no test can reach the real Hello. NOT VERIFIED on a machine with a Hello enrolment: CI cannot exercise it (docs/architecture/approver-app.md).
//   - one fixed credential name; the key is an RSA-2048 key that Windows Hello (TPM or software) holds. This code never sees, exports, copies or stores the private key.
//   - Sign = KeyCredential.RequestSignAsync(message): Hello shows its prompt (PIN / face / fingerprint) and returns RSA PKCS#1 v1.5 / SHA-256 over exactly the message bytes.
//   - the plain API is used (no window handle). If Windows shows no prompt for a console process, the follow-up is IKeyCredentialManagerInterop with the console window; see the doc.
//   - issue #101: `enroll` attests the key it just made (GetAttestationAsync; AttestationPolicy accepts only Success) and removes it again (DeleteAsync, this one call) when the attestation is not accepted.
//   - any API failure maps to NotReady / Unavailable / Missing; no exception text is ever printed.
internal static class HelloCredential
{
    public const string Name = "AlberaApprover.v1";
    public const int SignatureBytes = 256; // RSA-2048

    public static bool IsSupported() => KeyCredentialManager.IsSupportedAsync().GetAwaiter().GetResult();

    public static KeyCredentialRetrievalResult Open() => KeyCredentialManager.OpenAsync(Name).GetAwaiter().GetResult();

    /// <summary>The credential's public key (SPKI, DER), or null when it is not an RSA-2048 key.</summary>
    public static byte[]? PublicKey(KeyCredential credential)
    {
        CryptographicBuffer.CopyToByteArray(credential.RetrievePublicKey(CryptographicPublicKeyBlobType.X509SubjectPublicKeyInfo), out byte[] spki);
        using RSA rsa = RSA.Create();
        rsa.ImportSubjectPublicKeyInfo(spki, out _);
        return rsa.KeySize == 2048 ? spki : null;
    }
}

internal sealed class WindowsHelloKeyStore : IHelloKeyStore
{
    public KeyLookup Open() => Guard(() =>
    {
        if (!HelloCredential.IsSupported()) return KeyLookup.Of(KeyState.Unavailable);
        KeyCredentialRetrievalResult opened = HelloCredential.Open();
        return opened.Status switch
        {
            KeyCredentialStatus.Success => Present(opened.Credential),
            KeyCredentialStatus.NotFound => KeyLookup.Of(KeyState.Missing),
            KeyCredentialStatus.UserCanceled => KeyLookup.Of(KeyState.Cancelled),
            _ => KeyLookup.Of(KeyState.Unavailable),
        };
    });

    public KeyLookup Create(bool replace) => Guard(() =>
    {
        KeyCredentialRetrievalResult created = KeyCredentialManager.RequestCreateAsync(HelloCredential.Name,
            replace ? KeyCredentialCreationOption.ReplaceExisting : KeyCredentialCreationOption.FailIfExists).GetAwaiter().GetResult();
        return created.Status switch
        {
            KeyCredentialStatus.Success => Attested(created.Credential),
            KeyCredentialStatus.CredentialAlreadyExists => KeyLookup.Of(KeyState.AlreadyExists),
            KeyCredentialStatus.UserCanceled => KeyLookup.Of(KeyState.Cancelled),
            _ => KeyLookup.Of(KeyState.Unavailable),
        };
    });

    // Issue #101: a key that was just made is attested, and only AttestationPolicy's one accepted result keeps it. Anything else (including an exception from the API) removes the key
    // we just made, so an unattested key is never left under the fixed name for `enroll --show` or `approve` to find.
    private static KeyLookup Attested(KeyCredential credential)
    {
        string status;
        int chainBytes = 0, statementBytes = 0;
        try
        {
            KeyCredentialAttestationResult attestation = credential.GetAttestationAsync().GetAwaiter().GetResult();
            status = attestation.Status.ToString();
            chainBytes = (int)Math.Min(attestation.CertificateChainBuffer?.Length ?? 0, int.MaxValue);
            statementBytes = (int)Math.Min(attestation.AttestationBuffer?.Length ?? 0, int.MaxValue);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status = "Exception"; // the text is fixed: the exception message is never printed
        }
        if (AttestationPolicy.Accepts(status, chainBytes, statementBytes))
            return HelloCredential.PublicKey(credential) is { } spki ? KeyLookup.Present(spki, AttestationPolicy.Summary(status, chainBytes, statementBytes)) : KeyLookup.Of(KeyState.Unavailable);
        return KeyLookup.NotAttested($"{AttestationPolicy.Summary(status, chainBytes, statementBytes)}; {(RemoveCreatedKey() ? "the key was removed" : "the key could NOT be removed: run enroll --replace once Hello can attest")}");
    }

    private static bool RemoveCreatedKey()
    {
        try { KeyCredentialManager.DeleteAsync(HelloCredential.Name).GetAwaiter().GetResult(); return true; }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return false; }
    }

    private static KeyLookup Present(KeyCredential credential) => HelloCredential.PublicKey(credential) is { } spki ? KeyLookup.Present(spki) : KeyLookup.Of(KeyState.Unavailable);

    private static KeyLookup Guard(Func<KeyLookup> body)
    {
        try { return body(); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return KeyLookup.Of(KeyState.Unavailable); }
    }
}

internal sealed class WindowsHelloPresenceSigner : IPresenceSigner
{
    public SignResult Sign(byte[] message)
    {
        try
        {
            if (!HelloCredential.IsSupported()) return SignResult.NotReady;
            KeyCredentialRetrievalResult opened = HelloCredential.Open();
            if (opened.Status == KeyCredentialStatus.NotFound) return SignResult.NotReady; // not enrolled: nothing is sent, `enroll` fixes it
            if (opened.Status != KeyCredentialStatus.Success) return SignResult.Unavailable; // cancelled, locked, ...: Hello gave no proof
            KeyCredentialOperationResult signed = opened.Credential.RequestSignAsync(CryptographicBuffer.CreateFromByteArray(message)).GetAwaiter().GetResult();
            if (signed.Status != KeyCredentialStatus.Success) return SignResult.Unavailable;
            CryptographicBuffer.CopyToByteArray(signed.Result, out byte[] signature);
            return signature.Length == HelloCredential.SignatureBytes ? SignResult.Signed(signature) : SignResult.Unavailable;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return SignResult.NotReady; // the Hello API itself is not usable here: nothing is sent
        }
    }
}
