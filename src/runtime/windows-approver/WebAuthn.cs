using System.Runtime.InteropServices;

namespace Albera.Approver;

// The Windows WebAuthn API (webauthn.dll, P/Invoke; no package). This file is in the shipped build ONLY, like WindowsHello.cs: the test-faults build removes it, so no test can reach the real platform authenticator.
// Remote Desktop forwards these calls to the PC the person connects from, so Windows Hello asks THERE; at the console it asks this PC's own Hello (docs/architecture/approver-webauthn.md).
// The structure layouts, the version 1 options and the call sequence are those of the feasibility probe, which was run in the owner's Remote Desktop session on 2026-11-04 (create and sign both OK, console window handle
// used): every struct below is version 1, and the options ask for user verification required, any attachment, no resident key, attestation none. What was NOT run: the approval window's handle as the parent, a phone or
// a security key, an RS256 credential, and the cancel / error HRESULTs mapped in Outcome (documented in approver-app.md).
//   - this code never sees a private key: MakeCredential returns the authenticator data (with the public key), GetAssertion returns authenticator data and a signature
//   - no exception text and no request text is ever printed: a failure is an HRESULT and the API's own error name, nothing else
//   - every result the platform allocates is freed with its Free function, also when the copy fails
internal sealed class PlatformWebAuthn : IWebAuthnAuthenticator
{
    private const int DefaultTimeoutMs = 120_000;
    private const uint Version1 = 1, RequireUserVerification = 1, AttestationNone = 1, AnyAttachment = 0;
    private const int NteUserCancelled = unchecked((int)0x80090036), ErrorCancelled = unchecked((int)0x800704C7), ErrorTimeout = unchecked((int)0x800705B4);
    private const int PublicKeyAlgorithmEs256 = -7, PublicKeyAlgorithmRs256 = -257;

    public CreatedCredential MakeCredential(IntPtr window, byte[] userId, byte[] clientDataJson)
    {
        using Pins pins = new();
        Native.RpEntity rp = new() { dwVersion = Version1, pwszId = pins.Str(WebAuthnContract.RpId), pwszName = pins.Str("ALBERA approver") };
        Native.UserEntity user = new() { dwVersion = Version1, cbId = (uint)userId.Length, pbId = pins.Bytes(userId), pwszName = pins.Str("albera-approver"), pwszDisplayName = pins.Str("ALBERA approver") };
        Native.CoseParam[] algorithms =
        [
            new Native.CoseParam { dwVersion = Version1, pwszCredentialType = pins.Str("public-key"), lAlg = PublicKeyAlgorithmEs256 },
            new Native.CoseParam { dwVersion = Version1, pwszCredentialType = pins.Str("public-key"), lAlg = PublicKeyAlgorithmRs256 },
        ];
        Native.CoseParams algorithmList = new() { cCredentialParameters = (uint)algorithms.Length, pCredentialParameters = pins.Array(algorithms) };
        Native.ClientData clientData = new() { dwVersion = Version1, cbClientDataJSON = (uint)clientDataJson.Length, pbClientDataJSON = pins.Bytes(clientDataJson), pwszHashAlgId = pins.Str("SHA-256") };
        Native.MakeCredentialOptions options = new()
        {
            dwVersion = Version1, dwTimeoutMilliseconds = DefaultTimeoutMs, dwAuthenticatorAttachment = AnyAttachment, bRequireResidentKey = 0,
            dwUserVerificationRequirement = RequireUserVerification, dwAttestationConveyancePreference = AttestationNone,
        };
        int hr = Native.WebAuthNAuthenticatorMakeCredential(Parent(window), ref rp, ref user, ref algorithmList, ref clientData, ref options, out IntPtr attestation);
        if (hr != 0) return new CreatedCredential(Outcome(hr), null, null, Describe(hr));
        if (attestation == IntPtr.Zero) return new CreatedCredential(WebAuthnStatus.NotReady, null, null, "no result");
        try
        {
            Native.CredentialAttestation result = Marshal.PtrToStructure<Native.CredentialAttestation>(attestation);
            return new CreatedCredential(WebAuthnStatus.Ok, Copy(result.pbCredentialId, result.cbCredentialId), Copy(result.pbAuthenticatorData, result.cbAuthenticatorData));
        }
        finally { Native.WebAuthNFreeCredentialAttestation(attestation); }
    }

    public AssertionResult GetAssertion(IntPtr window, byte[] clientDataJson, IReadOnlyList<byte[]> allowCredentialIds)
    {
        using Pins pins = new();
        Native.Credential[] allowed = [.. allowCredentialIds.Select(id => new Native.Credential { dwVersion = Version1, cbId = (uint)id.Length, pbId = pins.Bytes(id), pwszCredentialType = pins.Str("public-key") })];
        Native.ClientData clientData = new() { dwVersion = Version1, cbClientDataJSON = (uint)clientDataJson.Length, pbClientDataJSON = pins.Bytes(clientDataJson), pwszHashAlgId = pins.Str("SHA-256") };
        Native.GetAssertionOptions options = new()
        {
            dwVersion = Version1, dwTimeoutMilliseconds = DefaultTimeoutMs, dwAuthenticatorAttachment = AnyAttachment, dwUserVerificationRequirement = RequireUserVerification,
            CredentialList = new Native.Credentials { cCredentials = (uint)allowed.Length, pCredentials = pins.Array(allowed) },
        };
        int hr = Native.WebAuthNAuthenticatorGetAssertion(Parent(window), WebAuthnContract.RpId, ref clientData, ref options, out IntPtr assertion);
        if (hr != 0) return new AssertionResult(Outcome(hr), null, null, null, Describe(hr));
        if (assertion == IntPtr.Zero) return new AssertionResult(WebAuthnStatus.NotReady, null, null, null, "no result");
        try
        {
            Native.Assertion result = Marshal.PtrToStructure<Native.Assertion>(assertion);
            return new AssertionResult(WebAuthnStatus.Ok, Copy(result.Credential.pbId, result.Credential.cbId), Copy(result.pbAuthenticatorData, result.cbAuthenticatorData), Copy(result.pbSignature, result.cbSignature));
        }
        finally { Native.WebAuthNFreeAssertion(assertion); }
    }

    // The parent window: the caller's (the approval window), else the console's, else the foreground window (the probe's order). The API needs a window; it only parents the prompt.
    private static IntPtr Parent(IntPtr window)
    {
        if (window != IntPtr.Zero) return window;
        IntPtr console = Native.GetConsoleWindow();
        return console != IntPtr.Zero ? console : Native.GetForegroundWindow();
    }

    // "Cancelled" = no proof: a prompt the person dismissed or let time out, and also NTE_USER_CANCELLED when no matching credential is on the device (Windows answers that way, so the two cannot be told apart).
    // Either way the approver sends decide presence_unavailable: the Authority fails the request, so it does not hang. Every other failure (no platform support, a bad parameter) is "not ready": nothing is sent and the request stays pending.
    private static WebAuthnStatus Outcome(int hr) => hr is NteUserCancelled or ErrorCancelled or ErrorTimeout ? WebAuthnStatus.Cancelled : WebAuthnStatus.NotReady;

    // The HRESULT and the API's own error name (a fixed vocabulary such as NotAllowedError), reduced to letters and digits.
    private static string Describe(int hr)
    {
        string name = Marshal.PtrToStringUni(Native.WebAuthNGetErrorName(hr)) ?? "";
        return $"0x{hr:X8} {new string([.. name.Where(char.IsAsciiLetterOrDigit).Take(32)])}".TrimEnd();
    }

    private static byte[] Copy(IntPtr source, uint length)
    {
        byte[] bytes = new byte[length];
        if (length > 0) Marshal.Copy(source, bytes, 0, (int)length);
        return bytes;
    }

    private sealed class Pins : IDisposable
    {
        private readonly List<GCHandle> handles = [];
        private readonly List<IntPtr> strings = [];

        public IntPtr Str(string text)
        {
            IntPtr pointer = Marshal.StringToHGlobalUni(text);
            strings.Add(pointer);
            return pointer;
        }

        public IntPtr Bytes(byte[] bytes)
        {
            GCHandle handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            handles.Add(handle);
            return handle.AddrOfPinnedObject();
        }

        public IntPtr Array<T>(T[] items) where T : struct
        {
            GCHandle handle = GCHandle.Alloc(items, GCHandleType.Pinned);
            handles.Add(handle);
            return handle.AddrOfPinnedObject();
        }

        public void Dispose()
        {
            foreach (GCHandle handle in handles) handle.Free();
            foreach (IntPtr pointer in strings) Marshal.FreeHGlobal(pointer);
        }
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)] public struct RpEntity { public uint dwVersion; public IntPtr pwszId, pwszName, pwszIcon; }
        [StructLayout(LayoutKind.Sequential)] public struct UserEntity { public uint dwVersion, cbId; public IntPtr pbId, pwszName, pwszIcon, pwszDisplayName; }
        [StructLayout(LayoutKind.Sequential)] public struct CoseParam { public uint dwVersion; public IntPtr pwszCredentialType; public int lAlg; }
        [StructLayout(LayoutKind.Sequential)] public struct CoseParams { public uint cCredentialParameters; public IntPtr pCredentialParameters; }
        [StructLayout(LayoutKind.Sequential)] public struct ClientData { public uint dwVersion, cbClientDataJSON; public IntPtr pbClientDataJSON, pwszHashAlgId; }
        [StructLayout(LayoutKind.Sequential)] public struct Credential { public uint dwVersion, cbId; public IntPtr pbId, pwszCredentialType; }
        [StructLayout(LayoutKind.Sequential)] public struct Credentials { public uint cCredentials; public IntPtr pCredentials; }
        [StructLayout(LayoutKind.Sequential)] public struct Extensions { public uint cExtensions; public IntPtr pExtensions; }
        [StructLayout(LayoutKind.Sequential)] public struct MakeCredentialOptions { public uint dwVersion, dwTimeoutMilliseconds; public Credentials CredentialList; public Extensions Extensions; public uint dwAuthenticatorAttachment; public int bRequireResidentKey; public uint dwUserVerificationRequirement, dwAttestationConveyancePreference, dwFlags; }
        [StructLayout(LayoutKind.Sequential)] public struct CredentialAttestation { public uint dwVersion; public IntPtr pwszFormatType; public uint cbAuthenticatorData; public IntPtr pbAuthenticatorData; public uint cbAttestation; public IntPtr pbAttestation; public uint dwAttestationDecodeType; public IntPtr pvAttestationDecode; public uint cbAttestationObject; public IntPtr pbAttestationObject; public uint cbCredentialId; public IntPtr pbCredentialId; }
        [StructLayout(LayoutKind.Sequential)] public struct GetAssertionOptions { public uint dwVersion, dwTimeoutMilliseconds; public Credentials CredentialList; public Extensions Extensions; public uint dwAuthenticatorAttachment, dwUserVerificationRequirement, dwFlags; }
        [StructLayout(LayoutKind.Sequential)] public struct Assertion { public uint dwVersion, cbAuthenticatorData; public IntPtr pbAuthenticatorData; public uint cbSignature; public IntPtr pbSignature; public Credential Credential; public uint cbUserId; public IntPtr pbUserId; }

        [DllImport("webauthn.dll")] public static extern int WebAuthNAuthenticatorMakeCredential(IntPtr hWnd, ref RpEntity rp, ref UserEntity user, ref CoseParams algs, ref ClientData clientData, ref MakeCredentialOptions options, out IntPtr attestation);
        [DllImport("webauthn.dll")] public static extern void WebAuthNFreeCredentialAttestation(IntPtr attestation);
        [DllImport("webauthn.dll", CharSet = CharSet.Unicode)] public static extern int WebAuthNAuthenticatorGetAssertion(IntPtr hWnd, string rpId, ref ClientData clientData, ref GetAssertionOptions options, out IntPtr assertion);
        [DllImport("webauthn.dll")] public static extern void WebAuthNFreeAssertion(IntPtr assertion);
        [DllImport("webauthn.dll")] public static extern IntPtr WebAuthNGetErrorName(int hr);
        [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    }
}
