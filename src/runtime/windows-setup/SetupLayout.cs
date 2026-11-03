namespace Albera.Setup;

/// <summary>One installed component: its name in build-hashes.json, the publish folder (relative to the update repo folder, '/' separators) and its exe.</summary>
internal sealed record ComponentLayout(string Name, string PublishDirectory, string Executable);

/// <summary>
/// Everything setup pins or expects, in one place. The identity is the repository, the workflow file and the branch of the Host build hashes run
/// (.github/workflows/host-build-hashes.yml). A test compares the component rows with Get-BuildSources in scripts/host/albera-host.ps1 and the attested files with the
/// workflow's subject list, so none of them can drift alone.
/// </summary>
internal static class SetupLayout
{
    public const string Repository = "BERORINPO/albera";
    public const string RepositoryUrl = "https://github.com/BERORINPO/albera";
    public const string WorkflowFile = "host-build-hashes.yml";
    public const string SourceRef = "refs/heads/main";
    /// <summary>GitHub's numeric ids of BERORINPO/albera and of its owner (`gh api repos/BERORINPO/albera`, read 2026-11-03). A repository that is deleted and re-created under the same name gets another id.</summary>
    public const string RepositoryId = "1424608761";
    public const string OwnerId = "215606621";
    /// <summary>The certificate's Subject Alternative Name of an attestation made by that workflow on main.</summary>
    public const string CertificateIdentity = RepositoryUrl + "/.github/workflows/" + WorkflowFile + "@" + SourceRef;
    public const string OidcIssuer = "https://token.actions.githubusercontent.com";
    public const string ProvenancePredicate = "https://slsa.dev/provenance/v1";
    public const string HostedRunner = "github-hosted";

    // ---- the update folder (made by the workflow, verified on a copy) ----
    public const string BuildHashesFile = "build-hashes.json";
    public const string BundlesDirectory = "bundles";
    public const string RepoDirectory = "repo";
    public const string HostScript = "repo/scripts/host/albera-host.ps1";
    public const string HostLibrary = "repo/scripts/host/albera-host-lib.ps1";
    public const string SetupExecutable = "setup/albera-setup.exe";
    public const string GhExecutable = "setup/gh.exe";
    public const string TrustedRoot = "setup/trusted_root.jsonl";

    public static readonly IReadOnlyList<ComponentLayout> Components =
    [
        new("broker", "src/runtime/windows-broker/bin/Release/net10.0-windows/win-x64/publish", "albera-windows-broker.exe"),
        new("authority", "src/runtime/windows-approval-authority/bin/Release/net10.0-windows/win-x64/publish", "albera-approval-authority.exe"),
        new("pipe-client", "src/runtime/windows-broker-pipe-client/bin/Release/net10.0-windows/win-x64/publish", "albera-windows-broker-pipe-client.exe"),
        // PR7: the Control Plane service host with its app tree (the `app` folder is inside the publish folder) and the approver app (the tray). The order is the tree hash's order (Get-CanonicalTreeHash).
        new("control-plane", "src/runtime/windows-control-plane-host/bin/Release/net10.0-windows/win-x64/publish", "albera-control-plane-host.exe"),
        new("approver", "src/runtime/windows-approver/bin/Release/net10.0-windows10.0.19041.0/win-x64/publish", "AlberaApprover.exe"),
    ];

    /// <summary>The per-file hash list of the Control Plane app tree (scripts/build-control-plane-app.mjs writes it BESIDE the publish folder, not inside it), relative to the update folder's repo folder.</summary>
    public const string ControlPlaneAppHashes = "src/runtime/windows-control-plane-host/bin/Release/net10.0-windows/win-x64/control-plane-app-hashes.json";

    /// <summary>The files that must each have a verified attestation (relative to the update folder). The DLLs next to the exe files are covered by the attested build-hashes.json and the tree hash.</summary>
    public static IReadOnlyList<string> AttestedFiles { get; } =
    [
        BuildHashesFile, HostScript, HostLibrary,
        .. Components.Select(c => $"{RepoDirectory}/{c.PublishDirectory}/{c.Executable}"),
        $"{RepoDirectory}/{ControlPlaneAppHashes}",
        SetupExecutable, GhExecutable, TrustedRoot,
    ];

    // ---- where things live on the owner's PC (no environment variable decides any of this) ----
    public const string SystemDirectory = @"C:\Windows\System32";
    public const string SystemRoot = @"C:\Windows";
    public const string ProgramFilesDirectory = @"C:\Program Files";
    public const string ProgramDataDirectory = @"C:\ProgramData";
    public const string InstalledSetupDirectory = @"C:\Program Files\Albera\bin\setup";
    public const string WorkRoot = @"C:\Program Files\Albera\setup-work";
    public const string PowerShellExecutable = @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
    /// <summary>The install record scripts/host/albera-host.ps1 keeps; its `setupRunId` is what the anti-rollback check reads.</summary>
    public const string InstallRecordFile = @"C:\ProgramData\Albera\install-manifest.json";
}
