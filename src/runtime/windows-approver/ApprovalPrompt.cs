using System.Globalization;
using System.Numerics;
using Albera.BrokerContract;

namespace Albera.Approver;

// What the approval window shows and which buttons it offers, as plain data and rules (no WinForms, so the unit harness checks every rule without a screen).
// The window (GuiApprovalWindow.cs) only draws this and forwards clicks.
//   - one prompt per pending request: purpose and action in Japanese, the task text exactly as sent, the VM, the expiry, the digest recomputed here
//   - non-ASCII characters are marked (the window paints them on another background); control, bidi, zero-width and other invisible characters, a digest mismatch or an
//     unreadable entry remove the approve buttons altogether (SafeText's rule: nothing that can hide or reorder text is approved on sight)
//   - the match code: the three candidates of MatchCode.Choices(approvalId, RECOMPUTED digest) are the only approve buttons. One wrong pick warns, the second sends deny.
//   - no click is possible during the first second after the window was shown, after expiry, while Hello is running, or after the prompt is finished
//   - nothing here approves anything: there is no auto, remember, all or on-timeout path, and the only approve call in the program is the window's click handler

/// <summary>A piece of displayed text; <see cref="Highlight"/> marks non-ASCII characters.</summary>
internal sealed record TextRun(string Text, bool Highlight);

internal sealed record DisplayLine(string Label, IReadOnlyList<TextRun> Runs);

internal enum BlockReason { None, InvalidEntry, DigestMismatch, HiddenCharacters, SigningBlocked, MatchCodeUnavailable }

internal enum PickOutcome { NotAllowed, Correct, Wrong, WrongTwice }

/// <summary>The only mutable part of a prompt, kept as a value: which candidates were picked wrongly, whether Hello / the Authority call is running, whether the prompt is over.</summary>
internal sealed record PickState(int WrongMask = 0, bool Busy = false, bool Finished = false)
{
    public int WrongCount => BitOperations.PopCount((uint)WrongMask);
}

internal sealed class ApprovalPrompt
{
    public const int ClickDelayMs = 1000, ChoiceCount = 3, WrongPicksToDeny = 2;

    private readonly MatchChoices? choices;

    private ApprovalPrompt(string? approvalId, PendingView? view, DateTimeOffset shownAt, bool signingBlocked)
    {
        ApprovalId = approvalId;
        View = view;
        ShownAt = shownAt;
        Block = Classify(view, signingBlocked, out choices);
    }

    public string? ApprovalId { get; }

    /// <summary>null when the Authority's entry could not be read (only deny is offered then)</summary>
    public PendingView? View { get; }

    public DateTimeOffset ShownAt { get; }

    public BlockReason Block { get; }

    public bool CanApprove => Block == BlockReason.None;

    /// <summary>The 3 candidates in the order they are shown; empty unless the approve buttons exist.</summary>
    public IReadOnlyList<string> Choices => CanApprove ? choices!.Choices : [];

    /// <param name="signingBlocked">this session cannot sign at all (a remote session where no WebAuthn key is registered: Hello does not work over Remote Desktop): no digit is offered, so nothing is clicked in vain</param>
    public static ApprovalPrompt From(ListedRequest item, DateTimeOffset shownAt, bool signingBlocked = false) => new(item.ApprovalId, item.View, shownAt, signingBlocked);

    // ---- what is shown ------------------------------------------------------------------------------------------------------------------

    /// <summary>One or two Japanese sentences saying what the action does. Our own text: never taken from the request.</summary>
    public string Summary => View is null ? "内容を読み取れない依頼です。" : Describe(View.Purpose, View.Action.Action);

    /// <summary>The task text exactly as sent (task.start), or null.</summary>
    public IReadOnlyList<TextRun>? TaskRuns => View?.Action.Args.TryGetValue("task", out object? task) == true && task is string text ? Runs(text) : null;

    /// <summary>Every other digest input, then the operation id and the digest result.</summary>
    public IReadOnlyList<DisplayLine> Details
    {
        get
        {
            if (View is not { } view) return [];
            List<DisplayLine> lines =
            [
                Line("VM", view.Action.ComputerId),
                Line("プロジェクト", view.Action.ProjectId),
                Line("動作", $"{view.Purpose} / {view.Action.Action}"),
            ];
            foreach ((string name, object value) in view.Action.Args.OrderBy(a => a.Key, StringComparer.Ordinal))
            {
                if (name == "task" && value is string) continue; // shown on its own
                string shown = value switch
                {
                    string s => s,
                    long n => n.ToString(CultureInfo.InvariantCulture),
                    bool b => b ? "true" : "false",
                    _ => "(未対応の型)",
                };
                lines.Add(Line(name == "vmId" ? "VM ID" : name, shown));
            }
            lines.Add(Line("操作 ID", view.OperationId));
            lines.Add(new DisplayLine("digest の再計算", [new TextRun(view.DigestMatches ? $"一致しました ({view.RecomputedDigest})" : $"一致しません: 表示内容から計算すると {view.RecomputedDigest} です", false)]));
            return lines;
        }
    }

    public string ExpiryText(DateTimeOffset now)
    {
        if (View is not { } view) return "期限: 不明";
        long left = view.ExpiresAt - now.ToUnixTimeSeconds();
        string when = DateTimeOffset.FromUnixTimeSeconds(Math.Min(view.ExpiresAt, 253_402_300_799)).ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture);
        return left > 0 ? $"期限: {when} (あと {left.ToString(CultureInfo.InvariantCulture)} 秒)" : "期限が切れました";
    }

    public string BlockText => Block switch
    {
        BlockReason.InvalidEntry => "この依頼は内容を読み取れないため、承認できません。拒否だけできます。",
        BlockReason.DigestMismatch => "表示内容から再計算した digest が Authority の値と一致しないため、承認できません。拒否だけできます。",
        BlockReason.HiddenCharacters => "見えない文字 (制御文字、向きを変える文字、幅のない文字など) が含まれているため、承認できません。拒否だけできます。",
        BlockReason.SigningBlocked => "リモートデスクトップでは、この鍵 (Windows Hello) は使えないため、承認できません。拒否だけできます。WebAuthn の鍵を enroll --webauthn で作り、set-approver で追加してください。",
        BlockReason.MatchCodeUnavailable => "照合コードを作れないため、承認できません。拒否だけできます。",
        _ => "",
    };

    // ---- what can be clicked ------------------------------------------------------------------------------------------------------------

    public bool IsExpired(DateTimeOffset now) => View is { } view && now.ToUnixTimeSeconds() >= view.ExpiresAt;

    public bool ClickDelayElapsed(DateTimeOffset now) => now - ShownAt >= TimeSpan.FromMilliseconds(ClickDelayMs);

    public bool ChoiceEnabled(PickState state, int index, DateTimeOffset now) =>
        CanApprove && index is >= 0 and < ChoiceCount && !state.Busy && !state.Finished && (state.WrongMask & (1 << index)) == 0 && state.WrongCount < WrongPicksToDeny && ClickDelayElapsed(now) && !IsExpired(now); // after two wrong picks the third is no guess: only deny is left

    /// <summary>Like the choices, deny waits for the first second (a reflex click on a button that just appeared decides nothing); it stops at expiry, while a call runs and when the prompt is over.</summary>
    public bool DenyEnabled(PickState state, DateTimeOffset now) => ApprovalId is not null && !state.Busy && !state.Finished && ClickDelayElapsed(now) && !IsExpired(now);

    /// <summary>The click on candidate <paramref name="index"/>. Correct: the caller starts Hello (state is Busy). Wrong: warn. WrongTwice: the caller sends deny (state is Busy).</summary>
    public (PickState State, PickOutcome Outcome) Pick(PickState state, int index, DateTimeOffset now)
    {
        if (!ChoiceEnabled(state, index, now)) return (state, PickOutcome.NotAllowed);
        if (index == choices!.CorrectIndex) return (state with { Busy = true }, PickOutcome.Correct);
        PickState next = state with { WrongMask = state.WrongMask | (1 << index) };
        return next.WrongCount >= WrongPicksToDeny ? (next with { Busy = true }, PickOutcome.WrongTwice) : (next, PickOutcome.Wrong);
    }

    public static PickState BeginDeny(PickState state) => state with { Busy = true };

    /// <summary>After the approve call. Done for good unless nothing was sent and the request is still waiting (no Hello key, no connection): then the person may try again.</summary>
    public static PickState AfterApprove(PickState state, CommandOutcome outcome) =>
        !outcome.Ok && outcome.ExitCode is ExitCodes.ServerRefused or ExitCodes.SignerUnavailable ? state with { Busy = false } : state with { Busy = false, Finished = true };

    public static PickState AfterDeny(PickState state) => state with { Busy = false, Finished = true };

    // ---- result texts -------------------------------------------------------------------------------------------------------------------

    public static string ApproveResultText(CommandOutcome outcome) => outcome.ExitCode switch
    {
        ExitCodes.Ok => "承認しました。",
        ExitCodes.SignerUnavailable when outcome.ErrorCode == PresenceSigning.RemoteSessionCode => "リモートデスクトップでは Windows Hello は使えません。何も送っていません。依頼はまだ待機中です。WebAuthn の鍵を enroll --webauthn で作り、set-approver で追加してください。",
        ExitCodes.SignerUnavailable => "署名に使う鍵 (Windows Hello または WebAuthn) が使えません (未登録など)。何も送っていません。依頼はまだ待機中です。AlberaApprover.exe enroll か keys list を確認してください。",
        ExitCodes.ServerRefused => "承認サービスにつながりません。何も送っていません。依頼はまだ待機中です。",
        ExitCodes.AuthorityRejected => $"承認サービスに断られました ({outcome.ErrorCode})。",
        ExitCodes.TransportUnknown => "Windows Hello の確認が終わらなかったか、結果を確認できませんでした。依頼は失敗として閉じられた可能性があります。必要ならルームからやり直してください。",
        ExitCodes.Refused => $"この PC では承認できない依頼です ({outcome.ErrorCode})。",
        _ => "内部エラーです。承認は完了していません。",
    };

    public static string DenyResultText(CommandOutcome outcome) => outcome.ExitCode switch
    {
        ExitCodes.Ok => "拒否しました。",
        ExitCodes.ServerRefused => "承認サービスにつながりません。拒否は送れていません。",
        ExitCodes.AuthorityRejected => $"承認サービスに断られました ({outcome.ErrorCode})。",
        ExitCodes.TransportUnknown => "結果を確認できませんでした。",
        _ => "内部エラーです。",
    };

    // ---- text helpers -------------------------------------------------------------------------------------------------------------------

    /// <summary>Splits text into runs of ASCII and non-ASCII characters; the non-ASCII runs are the highlighted ones.</summary>
    public static IReadOnlyList<TextRun> Runs(string value)
    {
        List<TextRun> runs = [];
        int start = 0;
        for (int i = 1; i <= value.Length; i++)
        {
            if (i < value.Length && (value[i] > '\u007F') == (value[start] > '\u007F')) continue;
            if (i > start) runs.Add(new TextRun(value[start..i], value[start] > '\u007F'));
            start = i;
        }
        return runs;
    }

    /// <summary>true for a control, format (bidi marks, zero-width, soft hyphen, BOM), line / paragraph separator, lone surrogate, private-use or unassigned character: text that can hide or reorder what is read.</summary>
    public static bool HasHiddenCharacters(string value)
    {
        for (int i = 0; i < value.Length; i++)
        {
            bool pair = char.IsHighSurrogate(value[i]) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]);
            UnicodeCategory category = char.GetUnicodeCategory(value, i);
            if (category is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator
                or UnicodeCategory.Surrogate or UnicodeCategory.PrivateUse or UnicodeCategory.OtherNotAssigned) return true;
            if (pair) i++;
        }
        return false;
    }

    private static DisplayLine Line(string label, string value) => new(label, Runs(value));

    private static BlockReason Classify(PendingView? view, bool signingBlocked, out MatchChoices? choices)
    {
        choices = null;
        if (view is null) return BlockReason.InvalidEntry;
        if (!view.DigestMatches) return BlockReason.DigestMismatch;
        if (AllStrings(view).Any(HasHiddenCharacters)) return BlockReason.HiddenCharacters;
        if (signingBlocked) return BlockReason.SigningBlocked; // an otherwise approvable request that this session cannot sign: say so before any digit is offered
        try { choices = MatchCode.Choices(view.ApprovalId, view.RecomputedDigest); } // the digest this app recomputed, the same one the Authority's presence message binds
        catch (MatchCodeException) { return BlockReason.MatchCodeUnavailable; }
        return BlockReason.None;
    }

    private static IEnumerable<string> AllStrings(PendingView view)
    {
        yield return view.Purpose;
        yield return view.OperationId;
        yield return view.Action.Action;
        yield return view.Action.ProjectId;
        yield return view.Action.ComputerId;
        foreach ((string name, object value) in view.Action.Args)
        {
            yield return name;
            if (value is string text) yield return text;
        }
    }

    private static string Describe(string purpose, string action) => (purpose, action) switch
    {
        ("guest.command", "task.start") => "VM の中で、AI に下のタスクを実行させます (タスクの開始)。",
        ("guest.command", "task.cancel") => "VM の中で実行中のタスクを止めます。",
        ("guest.command", "workspace.inspect") => "VM の作業フォルダの中身を見ます (読み取りだけ)。",
        (_, "synthetic.noop") => "動作確認用の依頼です。何も実行しません。",
        ("broker.operation", "environment.create") => "VM を新しく作ります。",
        ("broker.operation", "environment.inspect") => "VM の状態を調べます (読み取りだけ)。",
        ("broker.operation", "environment.start") => "VM を起動します。",
        ("broker.operation", "environment.stop") => "VM を止めます。",
        ("broker.operation", "environment.destroy") => "VM を削除します。元に戻せません。",
        ("broker.operation", "environment.retire") => "VM を止めてプロジェクトから外します。ディスクは一定期間 (既定 7 日) 残ります。",
        ("broker.operation", "environment.purge") => "VM のディスクを完全に消します。元に戻せません。",
        ("broker.operation", "environment.restore_checkpoint") => "VM を直前のチェックポイントの状態に戻します。最後のタスクの作業は消えます。",
        _ => "未知の動作です。内容をよく確認してください。",
    };
}
