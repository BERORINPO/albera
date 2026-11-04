using System.Text;
using System.Windows.Forms;
using Albera.Approver;
using Albera.BrokerContract;

// GUI mode (--tray): the rules of the approval window as data (ApprovalPrompt, ApprovalQueue) and the window itself built but never shown. A window handle is created (so the controls are
// real) but Show() is never called, so nothing appears on a screen. Fakes only: the channel is canned, the signer is the recording fake, no Hello, no key, no pipe.
internal static partial class Harness
{
    private static readonly DateTimeOffset Shown = DateTimeOffset.FromUnixTimeSeconds(Now);

    private static string TaskDto(string task) => $"{{\"action\":\"task.start\",\"projectId\":\"proj-alpha\",\"computerId\":\"pc-01\",\"args\":{{\"task\":\"{task}\"}}}}";

    private static string GuestDigest(string dto) => ActionDigest.Compute("guest.command", StrictJson.Parse(Encoding.UTF8.GetBytes(dto), 3));

    /// <summary>A guest.command / task.start entry; <paramref name="task"/> is JSON text (a backslash-u escape in it makes a zero-width character).</summary>
    private static string TaskEntry(string task, string? digest = null)
    {
        string dto = TaskDto(task);
        return Entry(Id1, dto, digest ?? GuestDigest(dto), purpose: "guest.command");
    }

    private static ApprovalPrompt PromptOf(string entry, DateTimeOffset? shownAt = null) => ApprovalPrompt.From(Parsed(entry), shownAt ?? Shown);

    private static ApprovalPrompt Normal() => PromptOf(Entry());

    private static FakeChannel DecidingChannel(params string[] entries) => new(request =>
        request.Contains("\"verb\":\"list\"") ? Page(entries) : request.Contains("\"decision\":\"deny\"") ? "{\"ok\":true,\"state\":\"denied\"}" : "{\"ok\":true,\"state\":\"approved\"}");

    private static ApproverCommands GuiCommands(FakeChannel channel, IPresenceSigner signer) =>
        new(channel, signer, TextWriter.Null, TextWriter.Null, TextReader.Null, () => Shown, interactive: false);

    private static void GuiPromptChecks()
    {
        Check("GUI prompt: the three buttons are MatchCode.Choices(approvalId, recomputed digest), distinct, with the correct one among them", () =>
        {
            ApprovalPrompt prompt = Normal();
            MatchChoices expected = MatchCode.Choices(Id1, DigestOf());
            Assert(prompt.CanApprove && prompt.Choices.SequenceEqual(expected.Choices) && prompt.Choices.Count == 3 && prompt.Choices.Distinct().Count() == 3, string.Join(',', prompt.Choices));
            Assert(prompt.Choices[expected.CorrectIndex] == MatchCode.Compute(Id1, DigestOf()), "the correct code is the match code");
        });
        Check("GUI prompt: no button can be pressed during the first second (999 ms no, 1000 ms yes), none after expiry, none while a call runs or once finished", () =>
        {
            ApprovalPrompt prompt = Normal();
            PickState fresh = new();
            for (int i = 0; i < 3; i++)
            {
                Assert(!prompt.ChoiceEnabled(fresh, i, Shown) && !prompt.ChoiceEnabled(fresh, i, Shown.AddMilliseconds(999)), $"choice {i} too early");
                Assert(prompt.ChoiceEnabled(fresh, i, Shown.AddMilliseconds(1000)), $"choice {i} after 1 s");
                Assert(!prompt.ChoiceEnabled(fresh, i, Shown.AddSeconds(117)) && !prompt.ChoiceEnabled(fresh, i, Shown.AddSeconds(500)), $"choice {i} at expiry");
                Assert(!prompt.ChoiceEnabled(fresh with { Busy = true }, i, Shown.AddSeconds(2)) && !prompt.ChoiceEnabled(fresh with { Finished = true }, i, Shown.AddSeconds(2)), $"choice {i} busy / finished");
            }
            Assert(!prompt.ChoiceEnabled(fresh, 3, Shown.AddSeconds(2)) && !prompt.ChoiceEnabled(fresh, -1, Shown.AddSeconds(2)), "only 3 candidates");
            DateTimeOffset afterDelay = Shown.AddSeconds(2);
            Assert(!prompt.DenyEnabled(fresh, Shown) && !prompt.DenyEnabled(fresh, Shown.AddMilliseconds(999)) && prompt.DenyEnabled(fresh, Shown.AddMilliseconds(1000)), "deny waits for the first second like the choices");
            Assert(prompt.DenyEnabled(fresh, afterDelay) && !prompt.DenyEnabled(fresh, Shown.AddSeconds(117)) && !prompt.DenyEnabled(fresh with { Busy = true }, afterDelay) && !prompt.DenyEnabled(fresh with { Finished = true }, afterDelay), "deny stops at expiry / busy / finished");
        });
        Check("GUI prompt: the correct pick goes to Hello; one wrong pick warns and disables that button; the second wrong pick means deny; a pick before 1 s is refused", () =>
        {
            ApprovalPrompt prompt = Normal();
            int correct = MatchCode.Choices(Id1, DigestOf()).CorrectIndex;
            int[] wrong = [.. Enumerable.Range(0, 3).Where(i => i != correct)];
            DateTimeOffset later = Shown.AddSeconds(2);
            Assert(prompt.Pick(new PickState(), correct, Shown).Outcome == PickOutcome.NotAllowed, "too early");
            (PickState ok, PickOutcome outcome) = prompt.Pick(new PickState(), correct, later);
            Assert(outcome == PickOutcome.Correct && ok.Busy && !prompt.ChoiceEnabled(ok, wrong[0], later), "correct -> Busy, nothing else can be pressed");
            (PickState once, PickOutcome first) = prompt.Pick(new PickState(), wrong[0], later);
            Assert(first == PickOutcome.Wrong && !once.Busy && !prompt.ChoiceEnabled(once, wrong[0], later) && prompt.ChoiceEnabled(once, correct, later), "one wrong: warn, that button off, the rest stay");
            (PickState twice, PickOutcome second) = prompt.Pick(once, wrong[1], later);
            Assert(second == PickOutcome.WrongTwice && twice.Busy, "two wrong: deny");
            Assert(prompt.Pick(once, wrong[0], later).Outcome == PickOutcome.NotAllowed, "the same wrong button cannot be counted twice");
        });
        Check("GUI prompt: a failure before anything was sent (no Hello key, no connection) lets the person try again; every other result ends the prompt", () =>
        {
            PickState busy = new(Busy: true);
            Assert(!ApprovalPrompt.AfterApprove(busy, new CommandOutcome(ExitCodes.SignerUnavailable)).Finished && !ApprovalPrompt.AfterApprove(busy, new CommandOutcome(ExitCodes.ServerRefused)).Busy, "69 and 66 retry");
            foreach (int code in new[] { ExitCodes.Ok, ExitCodes.AuthorityRejected, ExitCodes.TransportUnknown, ExitCodes.Refused, ExitCodes.Internal })
                Assert(ApprovalPrompt.AfterApprove(busy, new CommandOutcome(code)).Finished, $"exit {code} ends it");
            Assert(ApprovalPrompt.AfterDeny(busy).Finished, "deny ends it");
        });
        Check("GUI prompt: zero-width, bidi, format, control, separator and lone-surrogate characters in any shown text remove the approve buttons (deny stays)", () =>
        {
            foreach (string hidden in new[] { "run\\u200bit", "run\\u200cit", "run\\u200dit", "run\\ufeffit", "run\\u00adit", "run\\u2060it", "run\\u180eit" })
            {
                ApprovalPrompt prompt = PromptOf(TaskEntry(hidden));
                Assert(prompt.Block == BlockReason.HiddenCharacters && !prompt.CanApprove && prompt.Choices.Count == 0, hidden);
                Assert(!prompt.ChoiceEnabled(new PickState(), 0, Shown.AddSeconds(5)) && prompt.DenyEnabled(new PickState(), Shown.AddSeconds(5)), $"{hidden}: only deny");
            }
            foreach (int code in new[] { 0x0A, 0x00, 0x202E, 0x2028, 0x2029, 0x200B, 0x7F, 0x85 })
                Assert(ApprovalPrompt.HasHiddenCharacters("a" + char.ConvertFromUtf32(code) + "b"), $"U+{code:X4} is hidden");
            Assert(ApprovalPrompt.HasHiddenCharacters("a" + (char)0xD800 + "b"), "a lone surrogate is hidden");
            string ordinary = "ABC" + char.ConvertFromUtf32(0x3000) + char.ConvertFromUtf32(0xFF21) + char.ConvertFromUtf32(0xE9) + char.ConvertFromUtf32(0x1F600) + " plain ascii";
            Assert(!ApprovalPrompt.HasHiddenCharacters(ordinary), "a full-width space, a full-width letter, an accent and an emoji pair are only highlighted, not blocked");
        });
        Check("GUI prompt: a control or bidi character the contract already refuses makes an unreadable entry: no approve buttons; a digest mismatch also removes them", () =>
        {
            ApprovalPrompt bidi = PromptOf(TaskEntry("run\\u202eit", "sha256:" + new string('0', 64)));
            Assert(bidi.Block == BlockReason.InvalidEntry && !bidi.CanApprove && bidi.ApprovalId == Id1 && bidi.DenyEnabled(new PickState(), Shown.AddSeconds(5)), "unreadable: deny only");
            ApprovalPrompt mismatch = PromptOf(Entry(digest: "sha256:" + new string('0', 64)));
            Assert(mismatch.Block == BlockReason.DigestMismatch && !mismatch.CanApprove && mismatch.Choices.Count == 0 && mismatch.BlockText.Length > 0, "mismatch: deny only");
        });
        Check("GUI prompt: non-ASCII characters are split into highlighted runs; the task text is shown as sent; the summary is Japanese", () =>
        {
            IReadOnlyList<TextRun> runs = ApprovalPrompt.Runs("abc日本語def");
            Assert(runs.Count == 3 && runs[0] == new TextRun("abc", false) && runs[1] == new TextRun("日本語", true) && runs[2] == new TextRun("def", false), string.Join('|', runs));
            Assert(ApprovalPrompt.Runs("").Count == 0 && ApprovalPrompt.Runs("é").Single().Highlight, "empty and single");
            ApprovalPrompt prompt = PromptOf(TaskEntry("ホームページを直す a\\\"b"));
            Assert(prompt.CanApprove && string.Concat(prompt.TaskRuns!.Select(r => r.Text)) == "ホームページを直す a\"b" && prompt.TaskRuns!.Any(r => r.Highlight) && prompt.TaskRuns!.Any(r => !r.Highlight), "task text exact, mixed runs");
            Assert(prompt.Summary.Contains("タスク") && Normal().Summary.Contains("起動") && Normal().TaskRuns is null, "summaries");
            string details = string.Join('\n', Normal().Details.Select(l => $"{l.Label}: {string.Concat(l.Runs.Select(r => r.Text))}"));
            foreach (string field in new[] { "VM: pc-01", "プロジェクト: proj-alpha", "動作: broker.operation / environment.start", "cpu: 2", "fast: true", "vmName: alpha", "操作 ID: op-1", $"一致しました ({DigestOf()})" })
                Assert(details.Contains(field), $"details show {field}");
        });
        Check("GUI prompt: the expiry text counts down in seconds and says it is over at the expiry second", () =>
        {
            ApprovalPrompt prompt = Normal();
            Assert(prompt.ExpiryText(Shown).Contains("あと 117 秒") && prompt.ExpiryText(Shown.AddSeconds(116)).Contains("あと 1 秒") && prompt.ExpiryText(Shown.AddSeconds(117)) == "期限が切れました", prompt.ExpiryText(Shown));
            Assert(!prompt.IsExpired(Shown.AddSeconds(116)) && prompt.IsExpired(Shown.AddSeconds(117)), "expiry second");
        });
        Check("GUI queue: the oldest request gets the window, the others wait; with a window open nothing else opens; closed windows are counted; decided ones are pruned", () =>
        {
            ListedRequest a = Parsed(Entry(Id1)), b = Parsed(Entry(Id2, seq: "2")), c = Parsed(Entry("11111111-1111-4111-8111-111111111111", seq: "3"));
            List<ListedRequest> all = [a, b, c];
            QueueView start = ApprovalQueue.Next(all, new HashSet<string>(), windowOpen: false);
            Assert(start.OpenNow == a && start.Waiting == 2 && start.Closed == 0, "first opens, two wait");
            HashSet<string> handled = [Id1];
            QueueView open = ApprovalQueue.Next(all, handled, windowOpen: true);
            Assert(open.OpenNow is null && open.Waiting == 2 && open.Closed == 0, "a window is open: nothing opens, two wait");
            QueueView closed = ApprovalQueue.Next(all, handled, windowOpen: false);
            Assert(closed.OpenNow == b && closed.Waiting == 1 && closed.Closed == 1, "the first window was closed: the next opens");
            Assert(ApprovalQueue.Prune(handled, [b, c]).Count == 0 && ApprovalQueue.Prune(handled, all).SetEquals([Id1]), "decided requests leave the set");
            Assert(ApprovalQueue.Next([], new HashSet<string>(), false) == new QueueView(null, 0, 0), "empty list");
        });
        Check("GUI queue: the tray text says あと N 件 for the waiting ones, names a problem, and never exceeds the notification-area limit", () =>
        {
            Assert(ApprovalQueue.TrayText(new QueueView(null, 2, 0), null) == "ALBERA 承認: あと 2 件", ApprovalQueue.TrayText(new QueueView(null, 2, 0), null));
            Assert(ApprovalQueue.TrayText(new QueueView(null, 0, 0), null).Contains("待ちはありません") && ApprovalQueue.TrayText(new QueueView(null, 0, 1), null).Contains("閉じた依頼 1 件"), "idle / closed");
            Assert(ApprovalQueue.TrayText(new QueueView(null, 2, 0), "authority_unreachable").Contains("接続できません") && ApprovalQueue.TrayText(new QueueView(null, 2, 0), new string('x', 200)).Length <= ApprovalQueue.TrayTextLimit, "problem and limit");
        });
        Check("GUI queue: the wrong-pick ledger keeps picks across windows, only adds bits, and forgets requests that are no longer pending", () =>
        {
            WrongPickLedger ledger = new();
            Assert(ledger.For(Id1) == 0, "nothing at first");
            ledger.Record(Id1, 0b010);
            ledger.Record(Id1, 0b001);
            ledger.Record(Id1, 0);
            Assert(ledger.For(Id1) == 0b011 && ledger.For(Id2) == 0, "bits are merged, never cleared, per request");
            ledger.Prune([Parsed(Entry(Id2, seq: "2"))]);
            Assert(ledger.For(Id1) == 0, "a request that left the list is forgotten");
        });
        Check("GUI prompt: after two wrong picks on record no candidate can be picked (the remaining one would be a certainty)", () =>
        {
            ApprovalPrompt prompt = Normal();
            int correct = MatchCode.Choices(Id1, DigestOf()).CorrectIndex;
            PickState twice = new(WrongMask: Enumerable.Range(0, 3).Where(i => i != correct).Aggregate(0, (bits, i) => bits | (1 << i)));
            for (int i = 0; i < 3; i++) Assert(!prompt.ChoiceEnabled(twice, i, Shown.AddSeconds(5)), $"choice {i}");
            Assert(prompt.DenyEnabled(twice, Shown.AddSeconds(5)), "deny stays");
        });
        Check("GUI queue: a tray started for an account the approver pipe refuses (access denied) ends quietly; a service that is not up yet does not end it", () =>
        {
            Assert(ApprovalQueue.ShouldQuit(new CommandOutcome(ExitCodes.ServerRefused, ChannelCodes.AccessDenied)), "access_denied ends the tray");
            foreach (string code in new[] { ChannelCodes.AuthorityUnreachable, ChannelCodes.ServerIdentityUnavailable, ChannelCodes.ServerIdentityMismatch, ChannelCodes.Timeout })
                Assert(!ApprovalQueue.ShouldQuit(new CommandOutcome(ExitCodes.ServerRefused, code)), $"{code} keeps polling");
            Assert(!ApprovalQueue.ShouldQuit(new CommandOutcome(ExitCodes.Ok)), "a good answer keeps polling");
        });
        Check("GUI prompt: result texts say what happened and whether anything was sent", () =>
        {
            Assert(ApprovalPrompt.ApproveResultText(new CommandOutcome(ExitCodes.Ok)) == "承認しました。" && ApprovalPrompt.DenyResultText(new CommandOutcome(ExitCodes.Ok)) == "拒否しました。", "ok");
            Assert(ApprovalPrompt.ApproveResultText(new CommandOutcome(ExitCodes.SignerUnavailable)).Contains("何も送っていません") && ApprovalPrompt.ApproveResultText(new CommandOutcome(ExitCodes.ServerRefused)).Contains("何も送っていません"), "nothing sent");
            Assert(ApprovalPrompt.ApproveResultText(new CommandOutcome(ExitCodes.AuthorityRejected, "authority:request_expired")).Contains("authority:request_expired"), "authority code shown");
        });
        Check("GUI commands: ListPendingAsync returns the same parsed list as list, and a refused connection is an outcome, not an exception", () =>
        {
            FakeChannel channel = Listing(Entry(), Entry(Id2, seq: "2"));
            (CommandOutcome outcome, IReadOnlyList<ListedRequest> items) = GuiCommands(channel, Signing()).ListPendingAsync().GetAwaiter().GetResult();
            Assert(outcome.Ok && items.Count == 2 && items[0].View!.DigestMatches, "two requests");
            FakeChannel down = new(_ => throw new ChannelException(ChannelCodes.AuthorityUnreachable, sent: false));
            (CommandOutcome failed, IReadOnlyList<ListedRequest> none) = GuiCommands(down, Signing()).ListPendingAsync().GetAwaiter().GetResult();
            Assert(failed.ExitCode == ExitCodes.ServerRefused && failed.ErrorCode == ChannelCodes.AuthorityUnreachable && none.Count == 0, $"{failed.ExitCode} {failed.ErrorCode}");
        });
        Check("GUI commands: ApproveShownAsync refuses a digest mismatch before the signer is asked, and signs the RECOMPUTED digest otherwise (the same message as approve)", () =>
        {
            RecordingSigner signer = Signing();
            FakeChannel channel = DecidingChannel();
            ListedRequest bad = Parsed(Entry(digest: "sha256:" + new string('0', 64)));
            CommandOutcome refused = GuiCommands(channel, signer).ApproveShownAsync(bad.View!).GetAwaiter().GetResult();
            Assert(refused.ExitCode == ExitCodes.Refused && refused.ErrorCode == "digest_mismatch" && signer.Messages.Count == 0 && channel.Requests.Count == 0, "refused, nothing signed, nothing sent");
            CommandOutcome good = GuiCommands(channel, signer).ApproveShownAsync(Parsed(Entry()).View!).GetAwaiter().GetResult();
            Assert(good.Ok && signer.Messages.Count == 1 && signer.Messages[0].SequenceEqual(PresenceMessage.Build(Id1, DigestOf(), Challenge)) && channel.Decides == 1, "signed and decided once");
        });
    }

    // ---- the window itself (built, never shown) -----------------------------------------------------------------------------------------

    private static void Pump(Task task)
    {
        DateTime limit = DateTime.UtcNow.AddSeconds(15);
        while (!task.IsCompleted && DateTime.UtcNow < limit) { Application.DoEvents(); Thread.Sleep(5); }
        task.GetAwaiter().GetResult();
    }

    private sealed record Built(ApprovalWindow Window, FakeChannel Channel, RecordingSigner Signer, Func<DateTimeOffset> Clock, Action<TimeSpan> Advance);

    private static Built BuildWindow(string entry, bool remote = false, RecordingSigner? signer = null, FakeChannel? channel = null, int wrongMask = 0)
    {
        DateTimeOffset now = Shown;
        channel ??= DecidingChannel(entry);
        RecordingSigner recording = signer ?? Signing();
        ApproverCommands commands = new(channel, recording, TextWriter.Null, TextWriter.Null, TextReader.Null, () => now, interactive: false);
        ApprovalWindow window = new(PromptOf(entry), commands, () => now, remote, wrongMask);
        _ = window.Handle; // real controls and a real handle, but Show() is never called: nothing appears on a screen
        return new Built(window, channel, recording, () => now, step => { now += step; window.ApplyState(); });
    }

    private static void GuiWindowChecks()
    {
        Check("GUI window: no default or cancel button, no tab stop, Enter and Space are swallowed, and the window is shown without activation", () =>
        {
            Built built = BuildWindow(Entry());
            try
            {
                Assert(built.Window.AcceptButton is null && built.Window.CancelButton is null, "no default button");
                Assert(built.Window.ChoiceButtons.Count == 3 && built.Window.ChoiceButtons.All(b => !b.TabStop && !b.CanSelect) && !built.Window.DenyButton.TabStop && !built.Window.DenyButton.CanSelect, "buttons cannot take the keyboard focus");
                Assert((bool)typeof(ApprovalWindow).GetProperty("ShowWithoutActivation", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(built.Window)!, "ShowWithoutActivation");
                var cmdKey = typeof(ApprovalWindow).GetMethod("ProcessCmdKey", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
                foreach (Keys key in new[] { Keys.Enter, Keys.Space })
                    Assert((bool)cmdKey.Invoke(built.Window, new object[] { new Message(), key })!, $"{key} is swallowed");
            }
            finally { built.Window.Dispose(); }
        });
        Check("GUI window: the buttons are disabled for the first second, enabled after it, disabled again at expiry; PerformClick (no real mouse press) does nothing", () =>
        {
            Built built = BuildWindow(Entry());
            try
            {
                Assert(built.Window.ChoiceButtons.All(b => !b.Enabled) && !built.Window.DenyButton.Enabled, "every button is disabled at the start");
                built.Advance(TimeSpan.FromMilliseconds(999));
                Assert(built.Window.ChoiceButtons.All(b => !b.Enabled), "still disabled at 999 ms");
                built.Advance(TimeSpan.FromMilliseconds(1));
                Assert(built.Window.ChoiceButtons.All(b => b.Enabled) && built.Window.DenyButton.Enabled, "enabled at 1 s");
                foreach (Button button in built.Window.ChoiceButtons) button.PerformClick();
                built.Window.DenyButton.PerformClick();
                for (int i = 0; i < 5; i++) { Application.DoEvents(); Thread.Sleep(10); }
                Assert(built.Signer.Messages.Count == 0 && built.Channel.Decides == 0, "a click that did not start with a mouse press decided nothing");
                built.Advance(TimeSpan.FromSeconds(120));
                Assert(built.Window.ChoiceButtons.All(b => !b.Enabled) && !built.Window.DenyButton.Enabled && built.Window.StatusText.Contains("期限"), "disabled at expiry");
            }
            finally { built.Window.Dispose(); }
        });
        Check("GUI window: a button raises Click only for a left mouse press on it; a click without one (keyboard, invoke), after a right press, or after a release is dropped", () =>
        {
            using MouseOnlyButton button = new();
            int clicks = 0;
            button.Click += (_, _) => clicks++;
            const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
            System.Reflection.MethodInfo down = typeof(MouseOnlyButton).GetMethod("OnMouseDown", flags)!, up = typeof(MouseOnlyButton).GetMethod("OnMouseUp", flags)!, click = typeof(MouseOnlyButton).GetMethod("OnClick", flags)!;
            object[] left = [new MouseEventArgs(MouseButtons.Left, 1, 1, 1, 0)], right = [new MouseEventArgs(MouseButtons.Right, 1, 1, 1, 0)], none = [EventArgs.Empty];
            click.Invoke(button, none);
            Assert(clicks == 0, "no press");
            down.Invoke(button, right);
            click.Invoke(button, none);
            Assert(clicks == 0, "right press");
            down.Invoke(button, left);
            click.Invoke(button, none);
            Assert(clicks == 1, "left press");
            click.Invoke(button, none);
            Assert(clicks == 1, "the press is used up by its click");
            down.Invoke(button, left);
            up.Invoke(button, left);
            click.Invoke(button, none);
            Assert(clicks == 1, "a press that was released without a click does not arm the next click");
        });
        Check("GUI window: one wrong pick, then closing the window sends deny (closing is not a way to reset the guesses)", () =>
        {
            Built built = BuildWindow(Entry());
            int correct = MatchCode.Choices(Id1, DigestOf()).CorrectIndex;
            built.Advance(TimeSpan.FromSeconds(2));
            Pump(built.Window.HandleChoiceAsync((correct + 1) % 3));
            Assert(built.Channel.Decides == 0, "one wrong pick sends nothing yet");
            built.Window.Close();
            DateTime limit = DateTime.UtcNow.AddSeconds(15);
            while (!built.Window.IsDisposed && DateTime.UtcNow < limit) { Application.DoEvents(); Thread.Sleep(5); }
            Assert(built.Window.IsDisposed, "the window closed after the deny");
            Assert(built.Channel.Requests.Count(r => r.Contains("\"decision\":\"deny\"")) == 1 && built.Signer.Messages.Count == 0 && built.Channel.Requests.Count(r => r.Contains("\"decision\":\"approve\"")) == 0, "one deny, no Hello, no approve");
            Built plain = BuildWindow(Entry());
            plain.Window.Close();
            Assert(plain.Window.IsDisposed && plain.Channel.Decides == 0, "closing without a wrong pick sends nothing: the request stays pending");
        });
        Check("GUI window: a wrong pick survives closing and reopening (the tray hands the mask on), the reopened window has one guess left, and a second wrong pick there sends deny", () =>
        {
            FakeChannel failingDeny = new(request => request.Contains("\"decision\":\"deny\"") ? throw new ChannelException(ChannelCodes.AuthorityUnreachable, sent: false) : Page([Entry()]));
            Built first = BuildWindow(Entry(), channel: failingDeny);
            int correct = MatchCode.Choices(Id1, DigestOf()).CorrectIndex;
            int[] wrong = [.. Enumerable.Range(0, 3).Where(i => i != correct)];
            first.Advance(TimeSpan.FromSeconds(2));
            Pump(first.Window.HandleChoiceAsync(wrong[0]));
            first.Window.Close(); // the deny cannot be sent (the Authority is not reachable): the wrong pick must still be remembered
            DateTime limit = DateTime.UtcNow.AddSeconds(15);
            while (!first.Window.IsDisposed && DateTime.UtcNow < limit) { Application.DoEvents(); Thread.Sleep(5); }
            Assert(first.Window.IsDisposed && first.Window.WrongMask == 1 << wrong[0], $"mask {first.Window.WrongMask}");
            WrongPickLedger ledger = new();
            ledger.Record(Id1, first.Window.WrongMask);
            Built second = BuildWindow(Entry(), wrongMask: ledger.For(Id1));
            try
            {
                second.Advance(TimeSpan.FromSeconds(2));
                Assert(!second.Window.ChoiceButtons[wrong[0]].Enabled && second.Window.ChoiceButtons[wrong[1]].Enabled && second.Window.ChoiceButtons[correct].Enabled && second.Window.WarningText.Contains("前に 1 回"), "the earlier wrong pick is still wrong and still counted");
                Pump(second.Window.HandleChoiceAsync(wrong[1]));
                Assert(second.Channel.Requests.Count(r => r.Contains("\"decision\":\"deny\"")) == 1 && second.Signer.Messages.Count == 0 && second.Window.IsFinished, "the second wrong pick, in the new window, is the deny");
            }
            finally { second.Window.Dispose(); }
        });
        Check("GUI window: with two wrong picks already on record only deny is left (the third candidate is no guess)", () =>
        {
            int correct = MatchCode.Choices(Id1, DigestOf()).CorrectIndex;
            int mask = Enumerable.Range(0, 3).Where(i => i != correct).Aggregate(0, (bits, i) => bits | (1 << i));
            Built built = BuildWindow(Entry(), wrongMask: mask);
            try
            {
                built.Advance(TimeSpan.FromSeconds(2));
                Assert(built.Window.ChoiceButtons.All(b => !b.Enabled) && built.Window.DenyButton.Enabled, "choices off, deny on");
                Pump(built.Window.HandleChoiceAsync(correct));
                Assert(built.Signer.Messages.Count == 0 && built.Channel.Decides == 0, "even the correct one cannot be picked any more");
            }
            finally { built.Window.Dispose(); }
        });
        Check("GUI window: the topmost and no-activate styles are set at creation (WS_EX_TOPMOST | WS_EX_NOACTIVATE), not through Form.TopMost", () =>
        {
            Built built = BuildWindow(Entry());
            try
            {
                var createParams = (CreateParams)typeof(ApprovalWindow).GetProperty("CreateParams", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(built.Window)!;
                Assert((createParams.ExStyle & 0x00000008) != 0 && (createParams.ExStyle & 0x08000000) != 0, $"ExStyle {createParams.ExStyle:X}");
                Assert(!built.Window.TopMost, "Form.TopMost is not used");
            }
            finally { built.Window.Dispose(); }
        });
        Check("GUI window: CloseIfIdle closes a window that decided nothing and leaves one that already shows a result", () =>
        {
            Built idle = BuildWindow(Entry());
            idle.Window.CloseIfIdle();
            Assert(idle.Window.IsDisposed, "idle window closed");
            Built done = BuildWindow(Entry());
            try
            {
                done.Advance(TimeSpan.FromSeconds(2));
                Pump(done.Window.HandleDenyAsync());
                done.Window.CloseIfIdle();
                Assert(!done.Window.IsDisposed && done.Window.StatusText == "拒否しました。", "a window with a result stays until its own timer closes it");
            }
            finally { done.Window.Dispose(); }
        });
        Check("GUI window: the correct pick asks Hello once with the presence message and sends decide approve; the Authority's answer is shown", () =>
        {
            Built built = BuildWindow(Entry());
            try
            {
                built.Advance(TimeSpan.FromSeconds(2));
                int correct = MatchCode.Choices(Id1, DigestOf()).CorrectIndex;
                Pump(built.Window.HandleChoiceAsync(correct));
                Assert(built.Signer.Messages.Count == 1 && built.Signer.Messages[0].SequenceEqual(PresenceMessage.Build(Id1, DigestOf(), Challenge)), "one Hello request over the presence message");
                Assert(built.Channel.Requests.Count(r => r.Contains("\"decision\":\"approve\"")) == 1 && built.Window.StatusText == "承認しました。" && built.Window.IsFinished, built.Window.StatusText);
                Assert(built.Window.ChoiceButtons.All(b => !b.Enabled) && !built.Window.DenyButton.Enabled, "nothing can be pressed afterwards");
            }
            finally { built.Window.Dispose(); }
        });
        Check("GUI window: one wrong pick warns and sends nothing; the second wrong pick sends deny and never asks Hello", () =>
        {
            Built built = BuildWindow(Entry());
            try
            {
                built.Advance(TimeSpan.FromSeconds(2));
                int correct = MatchCode.Choices(Id1, DigestOf()).CorrectIndex;
                int[] wrong = [.. Enumerable.Range(0, 3).Where(i => i != correct)];
                Pump(built.Window.HandleChoiceAsync(wrong[0]));
                Assert(built.Window.WarningText.Contains("あと 1 回") && built.Channel.Decides == 0 && built.Signer.Messages.Count == 0 && !built.Window.ChoiceButtons[wrong[0]].Enabled, "warned, nothing sent");
                Pump(built.Window.HandleChoiceAsync(wrong[1]));
                Assert(built.Channel.Requests.Count(r => r.Contains("\"decision\":\"deny\"")) == 1 && built.Channel.Requests.Count(r => r.Contains("\"decision\":\"approve\"")) == 0 && built.Signer.Messages.Count == 0, "deny sent, no approve, no Hello");
                Assert(built.Window.StatusText == "拒否しました。" && built.Window.IsFinished, built.Window.StatusText);
            }
            finally { built.Window.Dispose(); }
        });
        Check("GUI window: a pick or a deny before the first second is dropped; after it the deny button sends deny without Hello", () =>
        {
            Built built = BuildWindow(Entry());
            try
            {
                Pump(built.Window.HandleChoiceAsync(MatchCode.Choices(Id1, DigestOf()).CorrectIndex));
                Assert(built.Signer.Messages.Count == 0 && built.Channel.Decides == 0 && !built.Window.IsFinished, "too early: nothing");
                Pump(built.Window.HandleDenyAsync());
                Assert(built.Channel.Decides == 0, "deny is dropped in the first second too");
                built.Advance(TimeSpan.FromSeconds(2));
                Pump(built.Window.HandleDenyAsync());
                Assert(built.Channel.Requests.Count(r => r.Contains("\"decision\":\"deny\"")) == 1 && built.Signer.Messages.Count == 0 && built.Window.StatusText == "拒否しました。", built.Window.StatusText);
            }
            finally { built.Window.Dispose(); }
        });
        Check("GUI window: a request with a zero-width character or a digest mismatch has no match-code buttons at all, only deny", () =>
        {
            foreach (string entry in new[] { TaskEntry("run\\u200bit"), Entry(digest: "sha256:" + new string('0', 64)) })
            {
                Built built = BuildWindow(entry);
                try
                {
                    built.Advance(TimeSpan.FromSeconds(2));
                    Assert(built.Window.ChoiceButtons.Count == 0 && built.Window.DenyButton.Enabled, "no approve buttons");
                    Pump(built.Window.HandleChoiceAsync(0));
                    Assert(built.Signer.Messages.Count == 0 && built.Channel.Decides == 0, "a forced pick still cannot approve");
                }
                finally { built.Window.Dispose(); }
            }
        });
        Check("GUI window: Hello not ready (no key) leaves the request waiting and lets the person try again; a window with the remote-desktop banner builds", () =>
        {
            Built built = BuildWindow(Entry(), remote: true, signer: new RecordingSigner(SignResult.NotReady));
            try
            {
                built.Advance(TimeSpan.FromSeconds(2));
                int correct = MatchCode.Choices(Id1, DigestOf()).CorrectIndex;
                Pump(built.Window.HandleChoiceAsync(correct));
                Assert(built.Window.StatusText.Contains("何も送っていません") && built.Channel.Decides == 0 && !built.Window.IsFinished, built.Window.StatusText);
                Assert(built.Window.ChoiceButtons[correct].Enabled, "can try again");
            }
            finally { built.Window.Dispose(); }
        });
    }

    private static void GuiChecks()
    {
        GuiPromptChecks();
        Exception? failure = null;
        Thread thread = new(() => { try { GuiWindowChecks(); WebAuthnWindowChecks(); } catch (Exception ex) { failure = ex; } });
        thread.SetApartmentState(ApartmentState.STA); // Windows Forms controls need an STA thread
        thread.Start();
        thread.Join();
        if (failure is not null) Check("GUI window: the checks ran to the end", () => throw failure);
    }
}
