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
}

export class RexCli {
  constructor(
    private readonly path: string,
    private readonly server?: string,
  ) {}

  private spawn(args: readonly string[]): ChildProcessWithoutNullStreams {
    const env = { ...process.env };
    for (const name of LOCATION_VARS) delete env[name];
    const argv = this.server ? ["-S", this.server, ...args] : [...args];
    return spawn(this.path, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
  }

  exec(args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(args);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, opts.timeoutMs ?? 30_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
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
