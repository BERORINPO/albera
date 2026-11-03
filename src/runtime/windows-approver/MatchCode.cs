// Match code v1. C# twin of src/runtime/broker-contract/match-code.mjs; match-code-vectors.json pins both (including the preimage bytes and the hash). BCL only.
// The room and the approver app show the same 4 digits for one approval so a person can tell they are looking at the same request. A display aid, not an authorization.
//
//   H        = SHA-256( UTF8("albera.match-code.v1") 0x00 UTF8(approvalId) 0x00 UTF8(actionDigest) )          32 bytes
//   code     = zero-padded 4 decimal digits of  u32be(H[0..4]) mod 10000
//   decoy k  = u32be(H[4k..4k+4]) mod 10000 for k = 1, 2; while it equals the correct code or an earlier decoy, add 1 (mod 10000). The 3 values are distinct.
//              No other pending approval's code is ever used as a decoy.
//   order    = Fisher-Yates over [correct, decoy1, decoy2]:  i = 2: j = H[12] mod 3, swap(i, j);  i = 1: j = H[13] mod 2, swap(i, j)
//   choices  = the three values in that order, each as 4 digits;  correctIndex = the position of the correct code
//
// approvalId is a lowercase UUID (8-4-4-4-12 hex digits); actionDigest is "sha256:" + 64 lowercase hex digits. Anything else throws MatchCodeException.
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Albera.Approver;

public sealed class MatchCodeException : Exception
{
    public string Code => "invalid_match_input";
    public string Field { get; }
    public MatchCodeException(string field) : base("invalid_match_input") { Field = field; }
}

public sealed record MatchChoices(string Code, IReadOnlyList<string> Choices, int CorrectIndex);

public static class MatchCode
{
    public const string Domain = "albera.match-code.v1";
    public const int Digits = 4;
    private const int Modulus = 10_000;
    private const string DigestPrefix = "sha256:";
    private const int DigestHexLength = 64;

    /// <summary>The exact bytes that are hashed.</summary>
    /// <exception cref="MatchCodeException">Field approvalId or actionDigest.</exception>
    public static byte[] Preimage(string? approvalId, string? actionDigest)
    {
        if (!IsApprovalId(approvalId)) throw new MatchCodeException("approvalId");
        if (!IsActionDigest(actionDigest)) throw new MatchCodeException("actionDigest");
        return [.. Encoding.UTF8.GetBytes(Domain), 0, .. Encoding.UTF8.GetBytes(approvalId!), 0, .. Encoding.UTF8.GetBytes(actionDigest!)];
    }

    /// <summary>The full SHA-256 of the preimage (32 bytes).</summary>
    public static byte[] Hash(string? approvalId, string? actionDigest) => SHA256.HashData(Preimage(approvalId, actionDigest));

    /// <returns>The 4-digit code for this approval and action digest.</returns>
    public static string Compute(string? approvalId, string? actionDigest) => Format(Reduce(Hash(approvalId, actionDigest), 0));

    /// <returns>The window's three candidates: the correct code and two decoys made from other ranges of the same hash, in a hash-determined order.</returns>
    public static MatchChoices Choices(string? approvalId, string? actionDigest)
    {
        byte[] hash = Hash(approvalId, actionDigest);
        List<int> values = [Reduce(hash, 0)];
        foreach (int offset in new[] { 4, 8 })
        {
            int value = Reduce(hash, offset);
            while (values.Contains(value)) value = (value + 1) % Modulus;
            values.Add(value);
        }
        int[] order = [0, 1, 2]; // 0 is the correct code
        Swap(order, 2, hash[12] % 3);
        Swap(order, 1, hash[13] % 2);
        return new MatchChoices(Format(values[0]), order.Select(k => Format(values[k])).ToArray(), Array.IndexOf(order, 0));
    }

    private static int Reduce(byte[] hash, int offset) => (int)(BinaryPrimitives.ReadUInt32BigEndian(hash.AsSpan(offset)) % Modulus);

    private static void Swap(int[] items, int i, int j) => (items[i], items[j]) = (items[j], items[i]);

    private static string Format(int value) => value.ToString(CultureInfo.InvariantCulture).PadLeft(Digits, '0');

    private static bool IsLowerHex(char c) => c is (>= '0' and <= '9') or (>= 'a' and <= 'f');

    private static bool IsApprovalId(string? value)
    {
        if (value is null || value.Length != 36) return false;
        for (int i = 0; i < value.Length; i++)
        {
            if (i is 8 or 13 or 18 or 23 ? value[i] != '-' : !IsLowerHex(value[i])) return false;
        }
        return true;
    }

    private static bool IsActionDigest(string? value) =>
        value is not null && value.Length == DigestPrefix.Length + DigestHexLength && value.StartsWith(DigestPrefix, StringComparison.Ordinal) && value.Skip(DigestPrefix.Length).All(IsLowerHex);
}
