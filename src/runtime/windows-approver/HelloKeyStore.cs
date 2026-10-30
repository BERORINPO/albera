namespace Albera.Approver;

internal enum KeyState { Present, Missing, AlreadyExists, Cancelled, Unavailable }

/// <summary>The outcome of looking at or creating the approver's Hello key. <see cref="PublicKey"/> (SPKI, DER) is set only when the state is Present. No private material ever appears here.</summary>
internal sealed record KeyLookup(KeyState State, byte[]? PublicKey)
{
    public static KeyLookup Of(KeyState state) => new(state, null);
    public static KeyLookup Present(byte[] publicKey) => new(KeyState.Present, publicKey);
}

/// <summary>
/// The approver's Windows Hello key credential (fixed name). Open never shows a Hello prompt. Create does (the person verifies once): with replace=false it fails with
/// AlreadyExists when the key exists, with replace=true it makes a new key in its place. The shipped implementation is WindowsHello.cs; test-faults builds use an in-memory fake.
/// </summary>
internal interface IHelloKeyStore
{
    KeyLookup Open();
    KeyLookup Create(bool replace);
}
