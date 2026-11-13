# MCP practical labs: learning guide

## Objectives

Build an understanding of a local MCP server, then apply it to read-only system
monitoring and a restricted, default-off note writer. These pages describe the
implementation in this repository, not a separate tutorial application.

Labs 1 and 2 retain their earlier milestone walkthroughs, including historical
tool counts and startup excerpts. Use [Lab 3](lab-03-mcp-security.md) and the
current source for the completed server's six-tool startup and write policy.

| Read next | Focus |
| --- | --- |
| [Lab 1: MCP fundamentals](lab-01-mcp-fundamentals.md) | Registration, validation, stdio, TypeScript, Inspector, and integration testing. |
| [Lab 2: DevOps monitoring](lab-02-devops-monitoring.md) | System identity, memory, filesystem capacity, and safe tool errors. |
| [Lab 3: MCP security and tool permissions](lab-03-mcp-security.md) | Startup permission, safe note creation, quota, auditing, and local trust assumptions. |
| [MCP architecture](concepts/mcp-architecture.md) | Host/client/server roles and the request lifecycle. |
| [Security fundamentals](concepts/security-fundamentals.md) | Input boundaries, permissions, disclosure, and test evidence. |
| [Troubleshooting](troubleshooting.md) | TS18003, TS2769, build configuration, stdio, and metric interpretation. |

## Prerequisites

Use Node.js 24 and npm, and understand basic TypeScript functions, promises, JSON,
and command-line processes. Run project commands from the repository root.

The documentation review observed Node.js `v24.21.0`. Installed versions reported
by `npm ls --depth=0` were server SDK `2.4.0`, Zod `4.6.7`, TypeScript `7.0.2`,
`tsx` `4.23.15`, and `@types/node` `26.6.6`. The
[manifest](../package.json) uses version ranges; the [lockfile](../package-lock.json)
records resolved dependencies. Do not substitute older SDK import paths from
unrelated tutorials.

## Architecture

The entry point is [src/index.ts](../src/index.ts). It registers `add_numbers` and
`server_health`, calls the monitoring registration function, initializes the
default-off note service, and connects a `StdioServerTransport`. The current
server advertises six tools, including `write_lab_note` even when writes are disabled.

```mermaid
flowchart LR
    Client["MCP client"] <-->|"stdio / JSON-RPC"| Entry["src/index.ts"]
    Entry --> Lab1["add_numbers + server_health"]
    Entry --> Registration["src/monitoring-tools.ts"]
    Registration --> Collectors["src/monitoring.ts"]
    Collectors --> OS["node:os + statfs"]
    Entry --> Notes["Default-off note service + write_lab_note"]
```

## Implementation

| File | Responsibility |
| --- | --- |
| [src/index.ts](../src/index.ts) | Server identity, tool registration, startup policy, stdio, and shutdown. |
| [src/monitoring.ts](../src/monitoring.ts) | OS reads, byte calculations, and numeric checks. |
| [src/monitoring-tools.ts](../src/monitoring-tools.ts) | Lab 2 schemas, annotations, readable summaries, and safe failures. |
| [src/note-tools.ts](../src/note-tools.ts) | Content-only contract, public schema adapter, validation-denial auditing, and annotations. |
| [src/lab-notes.ts](../src/lab-notes.ts) | Startup flag, validation, bounded queue, quota, write lifecycle, and cleanup. |
| [src/note-storage.ts](../src/note-storage.ts) | Linux/filesystem scope, secure directories, exclusive flags, and identity checks. |
| [src/note-audit.ts](../src/note-audit.ts) | Private per-session audit file, serialized events, sync, and safe diagnostics. |
| [test/mcp.test.mjs](../test/mcp.test.mjs) | Subprocess stdio discovery, addition, health, invalid addition input, and default-off note denial. |
| [test/monitoring.test.mjs](../test/monitoring.test.mjs) | In-memory MCP monitoring calls and deterministic calculation/failure tests. |
| [test/lab-notes.test.mjs](../test/lab-notes.test.mjs) | Note policy, schema, filesystem, quota, queue, auditing, and injected failures. |
| [test/note-stdio.test.mjs](../test/note-stdio.test.mjs) | Enabled startup through stdio, all five prior tools, and a second-process lock check. |
| [tsconfig.json](../tsconfig.json) | Strict source checking and compilation from `src` to `dist`. |

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the lockfile's dependencies on a fresh checkout; replaces an existing dependency installation. |
| `npm run dev` | Execute `src/index.ts` with `tsx`; this script does not enable watch mode. |
| `npm run typecheck` | Run `tsc --noEmit`; check without producing JavaScript. |
| `npm run build` | Run `tsc`; emit JavaScript and source maps to `dist` if checking succeeds. |
| `npm start` | Run the existing `dist/index.js`; it does not rebuild. |
| `npm test` | Build, then run `node --test test/*.test.mjs`. |

Use a real MCP client or [Inspector](lab-01-mcp-fundamentals.md#commands) to send
protocol messages. Starting the server alone is not a tool invocation.

## Verification

This is the shared verification record for these documents. It distinguishes
earlier implementation-session results from this documentation-only review.

| Evidence | Confirmed result | Scope or limitation |
| --- | --- | --- |
| Earlier Lab 2 `npm run typecheck` | Passed. | Checks source selected by `tsconfig.json`; JavaScript test files are outside that selection. |
| Earlier Lab 2 `npm run build` | Passed. | Does not establish behavior on every OS or filesystem. |
| Earlier sandbox `npm test` | Failed at the subprocess stdio test. | Nested Node subprocess output was empty; that restricted run did not validate stdio end to end. |
| Earlier local run outside the sandbox, `npm test` | All six tests passed. | One stdio test plus five monitoring tests, in that execution environment. |
| Completed Lab 3 implementation, `npm run typecheck` and `npm run build` | Passed. | Recorded implementation-session results. |
| Completed Lab 3 implementation, local `npm test` outside the sandbox | **26 passed, zero failed, zero skipped.** | Four test files, including enabled stdio and isolated Linux filesystem tests. |
| Current documentation review | Source, tests, scripts, README, and configuration inspected. | Runtime checks and Inspector were not rerun for this documentation-only change. |
| Inspector | Commands documented from upstream usage. | No successful Inspector session is recorded here; Inspector is not a project dependency. |
| TS18003 | A reported earlier lab setup issue. | Original diagnostic output and failing configuration are not retained; no exact historical cause is claimed. |
| TS2769 | Earlier reported handler inference issue; explicit SDK return annotations are present. | The first inspected copy already had `as const`; its observed compiler blocker was the misspelled `noEmitOnerror` option. |

Test assertions are evidence of the cases they exercise, not a claim of universal
portability, a security audit, or successful behavior in every sandbox. See
[troubleshooting](troubleshooting.md#verification) for the historical Lab 2 cases
and [Lab 3 verification](lab-03-mcp-security.md#verification) for current coverage.

## Troubleshooting

Start with [the diagnostic guide](troubleshooting.md). Check the working directory,
source selection, build status, and process I/O before changing dependencies.
Keep the sandbox failure and successful local run as separate results.

## Security

The monitoring tools accept no arguments and inspect only local APIs. Disk reads
use `process.cwd()`. Successful output intentionally reveals some host metadata;
read [security fundamentals](concepts/security-fundamentals.md) before connecting
the server to a client. Lab 3 adds local note creation only after explicit startup
enablement; it is a trusted local lab, not a production-grade multi-user
authorization system. The repository implements no authentication layer or
remote HTTP endpoint.

## DevOps relevance

The labs connect protocol contracts, build gates, repeatable verification, and
careful metric interpretation. They provide individual snapshots; there is no
metrics history, alerting pipeline, dashboard, or deployment automation.

## Lessons learned

Keep executable code as the source of truth. Separate types from runtime
validation, used capacity from available capacity, and recorded success from
untested assumptions. Update these pages when a tool contract or test changes.
