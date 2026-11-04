using System.Security.Cryptography;
using System.Text;

namespace Albera.Approver;

// The WebAuthn proof of the wire contract (docs/architecture/approver-webauthn.md, "The proof" and "Verification"). Pure functions: no platform call, no key, no I/O.
//   The approver builds the client data itself, from the message IT recomputed (never the Authority's), as exactly these UTF-8 bytes:
//     {"type":"webauthn.get","challenge":"<base64url(SHA-256(message))>","origin":"albera://approver","crossOrigin":false}
//   The authenticator signs authenticatorData || SHA-256(clientData). The frame carries credentialId, authenticatorData and signature; the client data is NOT sent (the Authority rebuilds it from its own entry).
internal static class WebAuthnContract
{
    public const string RpId = "approver.albera.local", Origin = "albera://approver";
    public const int AuthenticatorDataBytes = 37, MaxSignatureBytes = 1024, UserIdBytes = 16;
    private const byte UserPresent = 0x01, UserVerified = 0x04, AttestedData = 0x40, Extensions = 0x80;

    public static byte[] RpIdHash() => SHA256.HashData(Encoding.UTF8.GetBytes(RpId));

    /// <summary>The client data of an assertion over <paramref name="message"/> (a presence, policy or key message). The challenge is base64url of SHA-256 over the message.</summary>
    public static byte[] ClientDataForAssertion(byte[] message) =>
        Encoding.UTF8.GetBytes($"{{\"type\":\"webauthn.get\",\"challenge\":\"{B64.Url(SHA256.HashData(message))}\",\"origin\":\"{Origin}\",\"crossOrigin\":false}}");

    /// <summary>The client data of a credential creation. Its challenge is fresh random bytes: nothing is verified against it (attestation is "none"), it only has to be unique.</summary>
    public static byte[] ClientDataForCreation(byte[] challenge) =>
        Encoding.UTF8.GetBytes($"{{\"type\":\"webauthn.create\",\"challenge\":\"{B64.Url(challenge)}\",\"origin\":\"{Origin}\",\"crossOrigin\":false}}");

    /// <summary>The Authority's rule for an assertion (verification step 2): exactly 37 bytes, the rp id hash of this contract, user present and user verified set, attested data and extensions clear. The backup flags and the sign count are not judged here.</summary>
    public static bool IsPresenceAssertion(byte[] data) =>
        data.Length == AuthenticatorDataBytes && data.AsSpan(0, 32).SequenceEqual(RpIdHash()) && (data[32] & UserPresent) != 0 && (data[32] & UserVerified) != 0 && (data[32] & (AttestedData | Extensions)) == 0;

    /// <summary>
    /// Reads the authenticator data of a credential creation: rp id hash, user present, user verified and attested-data flags, then aaguid (16), credential id length (2), credential id, the COSE public key.
    /// Bytes after the key are allowed only when the extensions flag says so (they are not read). The credential id and the algorithm come out with the SPKI.
    /// </summary>
    public static bool TryReadCreated(byte[] data, out byte[] credentialId, out int alg, out byte[] spki)
    {
        credentialId = [];
        alg = 0;
        spki = [];
        const int idLengthAt = 53, idAt = 55;
        if (data.Length < idAt + 1 || !data.AsSpan(0, 32).SequenceEqual(RpIdHash())) return false;
        byte flags = data[32];
        if ((flags & UserPresent) == 0 || (flags & UserVerified) == 0 || (flags & AttestedData) == 0) return false;
        int idLength = (data[idLengthAt] << 8) | data[idLengthAt + 1];
        if (idLength is < 1 or > ApproverKeyRecord.MaxCredentialIdBytes || idAt + idLength >= data.Length) return false;
        int position = idAt + idLength;
        if (CoseKey.TryRead(data, ref position) is not { } key || (position != data.Length && (flags & Extensions) == 0)) return false;
        credentialId = data[idAt..(idAt + idLength)];
        (alg, spki) = key;
        return true;
    }
}

/// <summary>
/// What a WebAuthn assertion puts on the wire (the "presence" value of decide and policy_set, the "by" value of key_remove):
/// {"kind":"webauthn","credentialId":"&lt;b64url&gt;","authenticatorData":"&lt;b64&gt;","signature":"&lt;b64&gt;"}, in this key order.
/// </summary>
internal sealed record WebAuthnAssertion(byte[] CredentialId, byte[] AuthenticatorData, byte[] Signature)
{
    public string ToJson() =>
        $"{{\"kind\":\"webauthn\",\"credentialId\":\"{B64.Url(CredentialId)}\",\"authenticatorData\":\"{Convert.ToBase64String(AuthenticatorData)}\",\"signature\":\"{Convert.ToBase64String(Signature)}\"}}";

    /// <summary>The Authority's verification, run locally for a key whose record this process holds: the same credential, the authenticator data rule, and the signature over authenticatorData || SHA-256(client data of <paramref name="message"/>).</summary>
    public bool Verifies(ApproverKeyRecord key, byte[] message) =>
        key.Kind == ApproverKeyRecord.WebAuthnKind && key.CredentialId is { } credential && credential.AsSpan().SequenceEqual(CredentialId) && WebAuthnContract.IsPresenceAssertion(AuthenticatorData)
        && key.VerifySignature([.. AuthenticatorData, .. SHA256.HashData(WebAuthnContract.ClientDataForAssertion(message))], Signature);
}

// The message that removes an approver key (UTF-8, 0x00 between the parts). There is no add message: keys are added only by the elevated set-approver. The domain word differs from the presence, policy and
// self-check ones, and none of them (with its 0x00) is a prefix of another, so a signature over one kind of message can never verify as another kind.
//   remove: "albera.keyremove.v1" 0x00 keyId 0x00 hex(SHA-256(canonical record of that key)) 0x00 keyChallenge
internal static class KeyMessages
{
    public const string RemoveDomain = "albera.keyremove.v1";

    public static byte[] Remove(ApproverKeyRecord record, string challenge) => Encoding.UTF8.GetBytes($"{RemoveDomain}\0{record.KeyId}\0{record.Sha256Hex()}\0{challenge}");
}
