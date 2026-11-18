import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const LOCATION_VARS = ["REX_SESSION", "REX_BLOCK", "REX_WINDOW", "REX_CLIENT"];

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class RexError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number | null,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(`rex ${args.join(" ")} exited ${code}: ${(stderr || stdout).trim()}`);
  }
}

export interface ExecOptions {
  stdin?: string;
  timeoutMs?: number;
  /** How long to wait after SIGTERM before SIGKILL of the process group. */
  sigkillAfterMs?: number;
}

export class RexCli {
  constructor(
    private readonly path: string,
    private readonly server?: string,
  ) {}

  private spawn(args: readonly string[], detached = false): ChildProcessWithoutNullStreams {
    const env = { ...process.env };
    for (const name of LOCATION_VARS) delete env[name];
    const argv = this.server ? ["-S", this.server, ...args] : [...args];
    return spawn(this.path, argv, { env, stdio: ["pipe", "pipe", "pipe"], detached });
  }

  exec(args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      // Own process group so a timed-out CLI cannot leave a forked child behind.
      const child = this.spawn(args, true);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const killGroup = (sig: NodeJS.Signals) => {
        const pid = child.pid;
        if (!pid) return;
        try {
          process.kill(-pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            // already reaped
          }
        }
      };
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        fn();
      };
      child.stdin.on("error", () => {});
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), opts.sigkillAfterMs ?? 2_000);
      }, opts.timeoutMs ?? 30_000);
      child.on("error", (err) => finish(() => reject(err)));
      child.on("close", (code) => {
        if (timedOut) killGroup("SIGKILL");
        finish(() => resolve({ code, stdout, stderr, timedOut }));
      });
      child.stdin.end(opts.stdin ?? "");
    });
  }

  async run(args: readonly string[], opts?: ExecOptions): Promise<string> {
    const r = await this.exec(args, opts);
    if (r.timedOut) throw new RexError(args, r.code, "timed out", r.stdout);
    if (r.code !== 0) throw new RexError(args, r.code, r.stderr, r.stdout);
    return r.stdout;
  }

  async json<T = unknown>(args: readonly string[], opts?: ExecOptions): Promise<T> {
    const out = await this.run(args, opts);
    return (out.trim() === "" ? null : JSON.parse(out)) as T;
  }

  stream(args: readonly string[]): ChildProcessWithoutNullStreams {
    const child = this.spawn(args);
    child.stdin.end();
    child.stderr.resume();
    return child;
  }
}
