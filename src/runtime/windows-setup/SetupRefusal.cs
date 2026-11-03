namespace Albera.Setup;

/// <summary>A check failed: setup stops, prints one line "REFUSED code: message" and exits 3. Nothing is installed.</summary>
internal sealed class SetupRefusal(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>The command line is wrong: usage text and exit 2.</summary>
internal sealed class SetupUsageException(string message) : Exception(message);
