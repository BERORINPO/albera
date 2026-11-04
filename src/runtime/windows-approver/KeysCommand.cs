namespace Albera.Approver;

// `keys list | keys remove <keyId>`: the approver keys the Authority accepts presence from (docs/architecture/approver-webauthn.md, "Keys" and "Wire contract").
//   keys list           the Authority's `keys` reply, printed. Read only: no console, no key, no prompt.
//   keys remove <id>    needs a console and a typed yes. Refuses locally an unknown key and the last key. Signs "albera.keyremove.v1" 0x00 keyId 0x00 challenge with any registered key
//                       (a key that can sign now: a registered WebAuthn key, or the Hello key on a local session; a remote session with only Hello registered stops with remote_session BEFORE the typed yes)
//                       and sends key_remove. The message holds only the key id and the Authority's challenge, so a key from another device (a lost one) can be removed from here: no record of it is needed.
//                       When the removed key had signed the policy in force, the reply says policyReset and the person is told the policy is back to careful.
// There is NO `keys add`: a run-time add needs one signature by a registered key, which a same-user process could get at the moment of a real approval and use to register its own key. Keys are added only
// by the elevated `set-approver` (behind UAC), from the record file that `enroll --webauthn` writes; the Authority has no key_add verb.
// The proof is over a message this app built from the key id it was given and the challenge, never from other text the Authority sent. The Authority's reply is accepted only in the exact shape of the
// contract, and a remove is reported done only when the reply's key list shows it.
internal sealed class KeysCommand(IApproverChannel channel, IPresenceSigner hello, WebAuthnKit? kit, TextWriter output, TextWriter errors, TextReader input, bool interactive)
{
    private readonly KeyDirectory directory = new(channel);
    private readonly PresenceSigning signing = new(channel, hello, kit);

    private sealed class Stop(int exitCode, string code, string? hint = null) : Exception(code) { public int ExitCode { get; } = exitCode; public string? Hint { get; } = hint; }

    public Task<int> ListAsync() => GuardAsync(async () =>
    {
        WriteKeys(await directory.ListAsync());
        return ExitCodes.Ok;
    });

    public Task<int> RemoveAsync(string keyId) => GuardAsync(async () =>
    {
        WebAuthnKit webAuthn = kit ?? throw new Stop(ExitCodes.SignerUnavailable, "webauthn_unavailable");
        if (!interactive) throw new Stop(ExitCodes.Refused, "not_interactive", "hint: keys remove needs a console you type in; stdin is redirected, so nothing was read or sent");
        IReadOnlyList<RegisteredKey> keys = await directory.ListAsync();
        RegisteredKey target = keys.FirstOrDefault(k => k.KeyId == keyId) ?? throw new Stop(ExitCodes.Refused, "key_unknown", "hint: keys list shows the keys the Authority has");
        if (keys.Count == 1) throw new Stop(ExitCodes.Refused, "last_key", "hint: the Authority keeps at least one key; add another with set-approver before removing this one");
        SigningRoute route = SigningRoute.Choose(keys, webAuthn.RemoteSession); // a remote session that cannot sign stops here, before the typed yes
        if (route.Kind == RouteKind.RemoteNoKey) throw new Stop(ExitCodes.SignerUnavailable, PresenceSigning.RemoteSessionCode, PresenceSigning.RemoteSessionHint);
        output.Write($"This removes the approver key {SafeText.Quote(target.KeyId)} (kind {SafeText.Quote(target.Kind)}) from the Approval Authority. It will have {keys.Count - 1} key(s) left.\n");
        if (!Confirmed("remove this key")) throw new Stop(ExitCodes.Refused, "not_confirmed");

        string challenge = await directory.RemoveChallengeAsync(target.KeyId);
        output.Write(PresenceSigning.AskNotice(route, "the key change described above"));
        string by = ProofJson(route, signing.Sign(route, KeyMessages.Remove(target.KeyId, challenge)));

        RemoveResult removed = await directory.RemoveAsync(target.KeyId, challenge, by);
        if (removed.Keys.Any(k => k.KeyId == target.KeyId)) throw new ChannelException(ChannelCodes.InvalidResponse, sent: true); // the Authority said ok but still lists the key
        output.Write("result: key removed\n");
        if (removed.PolicyReset) output.Write("policy: set back to careful (the removed key had signed the policy in force). Every action asks you until a new policy is set with `policy set`.\n");
        WriteKeys(removed.Keys);
        return ExitCodes.Ok;
    });

    private static string ProofJson(SigningRoute route, SignResult signed) => signed.Status switch
    {
        SignStatus.Signed => PresenceSigning.PresenceJson(signed),
        SignStatus.Unavailable => throw new Stop(ExitCodes.SignerUnavailable, PresenceSigning.NoProofCode(route), PresenceSigning.NoProofHint(route)),
        _ => throw new Stop(ExitCodes.SignerUnavailable, "presence_signer_unavailable", PresenceSigning.NotReadyHint(route, signed)),
    };

    private void WriteKeys(IReadOnlyList<RegisteredKey> keys)
    {
        output.Write($"keys: {keys.Count}\n");
        foreach (RegisteredKey key in keys)
        {
            output.Write($"key {SafeText.Quote(key.KeyId)}\n  kind: {SafeText.Quote(key.Kind)}\n");
            if (key.CredentialId is not null) output.Write($"  credentialId: {SafeText.Quote(B64.Url(key.CredentialId))}\n");
        }
    }

    private bool Confirmed(string what)
    {
        output.Write($"Type yes to {what}: ");
        output.Flush();
        return input.ReadLine() == "yes";
    }

    private async Task<int> GuardAsync(Func<Task<int>> body)
    {
        try { return await body(); }
        catch (Stop stop)
        {
            errors.Write($"error: {stop.Message}\n");
            if (stop.Hint is not null) errors.Write(stop.Hint + "\n");
            return stop.ExitCode;
        }
        catch (AuthorityRefusal refusal) { errors.Write($"error: authority:{refusal.Code}\n"); return ExitCodes.AuthorityRejected; }
        catch (ChannelException ex) { errors.Write($"error: {ex.Code}\n"); return ex.Sent ? ExitCodes.TransportUnknown : ExitCodes.ServerRefused; }
    }
}
