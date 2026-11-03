namespace Albera.Approver;

// Which pending request gets the window, and what the tray says about the rest. One window per request, one window at a time; the second request onward waits and the tray
// shows "あと N 件". The caller keeps a set of ids it has already handled (a window was opened for them: decided, or closed without a decision). Plain data and rules, no WinForms.
internal sealed record QueueView(ListedRequest? OpenNow, int Waiting, int Closed);

internal static class ApprovalQueue
{
    public const int TrayTextLimit = 63; // NotifyIcon.Text used to be limited to 63 characters; stay under it

    /// <param name="pending">the Authority's list, oldest first</param>
    /// <param name="handled">ids that already had a window</param>
    /// <param name="windowOpen">true while a window is on screen</param>
    public static QueueView Next(IReadOnlyList<ListedRequest> pending, IReadOnlySet<string> handled, bool windowOpen)
    {
        List<ListedRequest> unhandled = [.. pending.Where(item => item.ApprovalId is not null && !handled.Contains(item.ApprovalId))];
        int closed = pending.Count(item => item.ApprovalId is not null && handled.Contains(item.ApprovalId));
        if (windowOpen) return new QueueView(null, unhandled.Count, Math.Max(0, closed - 1)); // the open window's own request is in `handled`: it is neither waiting nor closed
        return unhandled.Count == 0 ? new QueueView(null, 0, closed) : new QueueView(unhandled[0], unhandled.Count - 1, closed);
    }

    /// <summary>The ids worth remembering: those still pending. Decided requests leave the Authority's list, so the set cannot grow without bound.</summary>
    public static HashSet<string> Prune(IReadOnlySet<string> handled, IReadOnlyList<ListedRequest> pending) =>
        [.. pending.Where(item => item.ApprovalId is not null && handled.Contains(item.ApprovalId)).Select(item => item.ApprovalId!)];

    /// <summary>The approver pipe's ACL lets only the approver account in. The Run key starts the tray for every account that logs on, and for any other one the pipe answers "access denied": that tray ends quietly. "Not reachable" is not this (the service may still be starting): it keeps polling.</summary>
    public static bool ShouldQuit(CommandOutcome outcome) => outcome.ErrorCode == ChannelCodes.AccessDenied;

    public static string TrayText(QueueView view, string? problem)
    {
        string text = problem is not null ? $"ALBERA 承認: 接続できません ({problem})"
            : view.Waiting > 0 ? $"ALBERA 承認: あと {view.Waiting} 件"
            : view.Closed > 0 ? $"ALBERA 承認: 閉じた依頼 {view.Closed} 件"
            : "ALBERA 承認: 待ちはありません";
        return text.Length <= TrayTextLimit ? text : text[..TrayTextLimit];
    }
}
