using System.Globalization;
using System.Text;

namespace Albera.Approver;

// Safe display of a string that a human is asked to approve. Only printable ASCII is shown as it is; the quote and the backslash are backslash-escaped;
// EVERYTHING else (controls, bidi marks, separators, zero-width and combining characters, every non-ASCII letter, a lone surrogate) becomes \u{HEX} of the
// code point. So nothing can reorder, hide or imitate text (a Cyrillic "a" is \u{430}), and NFC and NFD forms of the same letters look different. The
// Authority already rejects control and bidi characters; this is the second layer, and it also makes look-alike letters visible.
internal static class SafeText
{
    public static string Quote(string value) => Quote(value, out _);

    public static string Quote(string value, out int escaped)
    {
        StringBuilder text = new("\"");
        escaped = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c is '"' or '\\') text.Append('\\').Append(c);
            else if (c is >= ' ' and <= '~') text.Append(c);
            else
            {
                int code = c;
                if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1])) code = char.ConvertToUtf32(c, value[++i]);
                text.Append("\\u{").Append(code.ToString("X", CultureInfo.InvariantCulture)).Append('}');
                escaped++;
            }
        }
        return text.Append('"').ToString();
    }
}
