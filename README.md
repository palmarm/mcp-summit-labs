# MCP Practical Labs 1–3

A small local MCP server using Node.js 24, TypeScript 7, MCP server SDK 2.4.0,
and Zod 4. It communicates through stdio; stdout carries only MCP messages.
Startup diagnostics go to stderr.

## Learning documentation

Start with the [learning guide](docs/README.md), then follow
[Lab 1: MCP fundamentals](docs/lab-01-mcp-fundamentals.md),
[Lab 2: DevOps monitoring](docs/lab-02-devops-monitoring.md), and
[Lab 3: MCP security and tool permissions](docs/lab-03-mcp-security.md).
See [MCP architecture](docs/concepts/mcp-architecture.md),
[security fundamentals](docs/concepts/security-fundamentals.md), and
[troubleshooting](docs/troubleshooting.md) for supporting explanations and the
recorded verification results and limitations.

```sh
npm install
npm run typecheck
npm run build
npm test
npm start
```

Configure an MCP client to launch `node /absolute/path/to/first-mcp-server/dist/index.js`.
Set its working directory deliberately: `disk_usage` inspects the filesystem
containing that directory, regardless of where the server JavaScript is located.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `add_numbers` | `a`, `b`: numbers | Text containing their sum. |
| `server_health` | `{}` | JSON text with `status` and `uptimeSeconds`. |
| `system_info` | `{}` | `platform`, `architecture`, `kernelRelease`, `hostname`, `nodeVersion`. |
| `memory_usage` | `{}` | `totalBytes`, `freeBytes`, `usedBytes`, `utilizationPercent`. |
| `disk_usage` | `{}` | `path`, `totalBytes`, `availableBytes`, `usedBytes`, `utilizationPercent`. |
| `write_lab_note` | `content`: validated text | `noteId`, generated `filename`, and `bytesWritten`; writes are disabled by default. |

The three monitoring tools advertise output schemas and read-only annotations.
Successful calls return machine-readable `structuredContent` alongside readable
text. For example, call `memory_usage` with `{}` and read
`result.structuredContent.usedBytes`. Failed reads return `isError: true` with a
generic text message, without raw OS errors, stack traces, or partial metrics.

`write_lab_note` is a separate, additive write capability. Only the startup flag
`--enable-note-writes` enables it, on supported trusted local Linux filesystems.
It creates notes under `lab-data/notes/` and private audits under `lab-data/audit/`.
It implements no user authentication. See [Lab 3](docs/lab-03-mcp-security.md) for
the input limits, security assumptions, audit failures, and manual verification.

## Interpreting the metrics

`system_info` uses `node:os` for platform, architecture, kernel release, and
hostname, and `process.version` for the running Node.js version.

`memory_usage` uses [`os.totalmem()` and `os.freemem()`](https://nodejs.org/api/os.html#osfreemem).
Used bytes = total bytes minus free bytes. On Linux this includes reclaimable
filesystem caches and buffers; it is not application-only memory or a calculation
based on Linux `MemAvailable`. Utilization is `usedBytes / totalBytes * 100`.

`disk_usage` calls [`statfs(process.cwd(), { bigint: true })`](https://nodejs.org/api/fs.html#class-fsstatfs)
from `node:fs/promises`, using the reported block size (`bsize`):

- Total bytes = `blocks * bsize`.
- Available bytes = `max(0, bavail) * bsize`: space available to unprivileged users.
- Used bytes = `(blocks - bfree) * bsize`: allocated space, excluding all free blocks.
- Utilization = `usedBytes / totalBytes * 100`.

`bfree` counts all free blocks, including any reserved blocks; `bavail` excludes
blocks reserved from unprivileged users. Consequently, total minus available can
exceed used bytes. This percentage may differ from `df`, which can use
`used / (used + available)`. Negative availability (possible when over quota or
capacity) is reported as zero. The result describes the containing filesystem,
not the size of the project directory or an estimate of user quota.

Both percentages are zero for a zero-capacity reading. Byte counts are nonnegative
safe JSON integers; invalid statistics or counts beyond JavaScript's safe integer
range produce a tool error. Metrics fluctuate, and container/OS reporting may
describe host resources rather than the process's resource limits.

## Security boundaries

The monitoring tools reject all arguments, including client-provided paths.
`disk_usage` always uses the server process's current working directory. It never
executes shell commands, traverses directories, reads file contents, or writes to
the filesystem. No external services, telemetry, or extra dependencies are used.
The host APIs remain subject to the permissions of the server process.

These tools intentionally expose hostname, kernel/runtime versions, capacity
metrics, and the working directory on successful reads. Connect only trusted MCP
clients and choose a suitable launch directory. Tool annotations describe behavior;
they are not an authorization mechanism. Error responses omit internal details.

## Tests

`npm test` builds first and runs Node's test runner. The existing stdio integration
test still checks discovery, addition, health, and invalid calculator input, with
the expected tool list extended through Lab 3 and a default-off note denial.
In-memory MCP tests exercise monitoring
registration, schemas, real invocations, numeric bounds, safe failures, and rejection
of client paths. Deterministic reader fixtures check reserved disk blocks, zero
capacity, invalid readings, and oversized counts without relying on exact live
metrics or host-specific failures. Lab 3 adds isolated temporary-directory tests
for note permissions, auditing, quota, concurrency, and failures, including an
enabled stdio session. Some tests change permissions only inside their temporary
fixtures. The recorded local Lab 3 run passed 26 tests, with zero failures or skips.

Some execution sandboxes restrict subprocess stdio and prevent the stdio test
from running successfully. Report that failure explicitly; it does not replace a
successful integration test in an environment that supports child processes.
