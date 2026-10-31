namespace Albera.Approver;

// Issue #101: the Windows Hello key is scoped to the PACKAGE FAMILY of the app that makes it, so the approver only touches Hello when it runs from its own MSIX package. An unpackaged
// copy (the same exe started from a build folder, or by another program of the same account) would see a different set of Hello credentials, which is the exact weakness the
// package removes, so every command that reaches Hello refuses to run unpackaged. The identity below is a MIRROR of scripts/approver-msix-identity.json (the one registry the
// packaging scripts read); test/approver-msix.test.mjs fails if the two disagree.
internal static class ApproverIdentity
{
    public const string PackageName = "Albera.LocalApprover";
    public const string Publisher = "CN=ALBERA Local Approver";
}

/// <summary>What the running process knows about the package it was started from. <see cref="IsDevelopmentMode"/> is true for a package registered loose from a folder (a developer registration), whose files the user can still edit.</summary>
internal sealed record PackageIdentity(string Name, string Publisher, bool IsDevelopmentMode)
{
    public static PackageIdentity Expected { get; } = new(ApproverIdentity.PackageName, ApproverIdentity.Publisher, false);
}

internal interface IPackageIdentitySource
{
    /// <summary>The identity of the package this process runs from, or null when it is not packaged.</summary>
    PackageIdentity? Current();
}

/// <summary>Why a Hello-touching command was refused before it reached Hello: a fixed code (printed as `error: code`) and a one-line hint.</summary>
internal sealed record GateRefusal(string Code, string Hint);

/// <summary>
/// The packaged-only rule. Check() returns null when the process runs from the approver's own, installed (not loose, development-mode) package, else the refusal. Commands call it
/// after their own console check and BEFORE they open the pipe, ask for a typed word or reach Hello.
/// </summary>
internal sealed class HelloGate(IPackageIdentitySource source)
{
    public GateRefusal? Check()
    {
        PackageIdentity? current = source.Current();
        if (current is null)
            return new GateRefusal("not_packaged", "hint: this copy is not running from the ALBERA approver package, so Windows Hello would give it a different, unprotected key. Install the package (docs/architecture/approver-app.md, \"Package and install\") and start AlberaApprover.exe from there. Nothing was done");
        if (current.Name != ApproverIdentity.PackageName || current.Publisher != ApproverIdentity.Publisher)
            return new GateRefusal("wrong_package", "hint: this program is running inside a package that is not the ALBERA approver package. Nothing was done");
        if (current.IsDevelopmentMode)
            return new GateRefusal("development_mode_package", "hint: the package is registered from a folder (development mode), whose files can still be edited. Install the signed .msix instead. Nothing was done");
        return null;
    }
}
