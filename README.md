# MCP Practical Labs 1–4

A local MCP server, operations controller, and Gemini agent using Node.js 24,
TypeScript 7, MCP client/server SDKs 2.4.0, and Zod 4. The original server uses
stdio, with only MCP messages on its stdout. An independent read-only HTTP
entry point binds to `127.0.0.1`. Controller/agent CLIs emit JSON on stdout and
readable summaries on stderr.

## Learning documentation

Start with the [learning guide](docs/README.md), then follow
[Lab 1: MCP fundamentals](docs/lab-01-mcp-fundamentals.md),
[Lab 2: DevOps monitoring](docs/lab-02-devops-monitoring.md),
[Lab 3: MCP security and tool permissions](docs/lab-03-mcp-security.md),
[Lab 4A: MCP operations controller](docs/lab-04a-mcp-operations-controller.md),
[Lab 4B: AI agent orchestration](docs/lab-04b-ai-agent-orchestration.md), and
[Lab 4C: local Streamable HTTP](docs/lab-04c-streamable-http.md).
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

The stdio server advertises all six tools below. The independent HTTP endpoint
registers only `system_info`, `memory_usage`, and `disk_usage`. Controller and
agent calls are explicitly restricted to those three on either transport.

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
the filesystem. The collectors use local OS APIs without an external monitoring
service. Live agent use sends the question and sanitized measurements to Google's
Gemini API through `@google/genai`; mock mode does not. The host APIs remain
subject to the permissions of the server process.

These tools intentionally expose hostname, kernel/runtime versions, capacity
metrics, and the working directory on successful reads. Connect only trusted MCP
clients and choose a suitable launch directory. Tool annotations describe behavior;
they are not an authorization mechanism. Error responses omit internal details.

## Controller and agent workflows

After building, run these offline examples from the repository root:

```sh
node dist/controller/cli.js
node dist/controller/cli.js --simulate high-memory
node dist/agent/cli.js --mock all --simulate healthy "Check deployment readiness"
```

Readiness uses the reported memory/disk utilization: warning >=75%, critical
>=90%. Exit `0` means healthy/warning, `1` critical, and `2` unknown or execution
failure. Incomplete or invalid data is unknown, even with another critical check.
The deterministic evaluator sets status; the model's explanation is advisory.

For local HTTP, start `npm run start:http` in one terminal, then connect from
another:

```sh
node dist/controller/cli.js --transport http
node dist/agent/cli.js --mock all --transport http "Check deployment readiness"
```

HTTP pins stateless protocol `2026-07-28`; stdio retains tested `2025-11-25`
behavior. The independent HTTP server exposes no write tool. Origin/Host checks
are not authentication; this is a trusted loopback-only lab, without public HTTP
security or production-readiness claims. See
[Lab 4C commands](docs/lab-04c-streamable-http.md#commands) for lifecycle and
invalid-Origin verification.

Live agent use requires an exported `GEMINI_API_KEY`; `GEMINI_MODEL` overrides
the default `gemini-3.8-flash`. Never put a key in a CLI argument or log. See
[Lab 4B configuration](docs/lab-04b-ai-agent-orchestration.md#live-gemini-configuration)
for private environment setup, the successful reported `gemini-3.5-flash-lite`
workflow, and metadata-versus-generation limitations. There is no automatic
model fallback or billing/quota verification.

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

Lab 4 adds calculation/discovery/reporting and cleanup checks, deterministic
model fixtures, sanitization and request-policy tests, and isolated-port HTTP
integration tests. Recorded stage totals were **56 passing tests for 4A**, **80
for 4B**, and **96 for 4C**. The Lab 4C implementation run also passed typecheck,
build, and `git diff --check`. These are recorded implementation results;
application tests and live API requests were not rerun for the documentation
update. See the [verification record](docs/README.md#verification) for scope and
operator-reported live outcomes.

Some execution sandboxes restrict subprocess stdio and prevent the stdio test
from running successfully. Report that failure explicitly; it does not replace a
successful integration test in an environment that supports child processes.
