namespace Albera.Lab;

// Issue #23 lab tool (test-only). One self-contained exe, three roles:
//   service <config.json>   run as the service the SCM started (own-process, STOP only); the config names the job to run
//   run <config.json>       the same job outside the SCM (host-side tests; no service involved)
//   <probe> ...             token | pipe-open | scm | openproc | squat (see Probes.cs)
// Exit: 0 ok, 64 bad usage, 1 not started by the SCM; `run` returns the job's exit code.
internal static class Program
{
    private static int Main(string[] args)
    {
        switch (args)
        {
            case ["service", var config]: return ServiceHost.Run(config);
            case ["run", var config]:
                using (JobRunner job = new(JobConfig.Load(config))) return job.Run();
            default: return args.Length > 0 ? Probes.Run(args) : 64;
        }
    }
}
