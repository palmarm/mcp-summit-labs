# Concept: security fundamentals

## Objectives

Identify the inputs the server accepts, the host details it exposes, and the
checks it actually enforces. Understand why read-only operations still require
careful client and process configuration.

## Prerequisites

Read [MCP architecture](mcp-architecture.md) and the
[Lab 2 contracts](../lab-02-devops-monitoring.md#implementation). Understand
the difference between a process's OS permissions and a schema for JSON input.

## Architecture

```mermaid
flowchart LR
    Client["Client-controlled tool arguments"] --> Validation["SDK + Zod input validation"]
    Validation --> Handler["Registered handler"]
    Handler --> APIs["Local OS APIs under process permissions"]
    APIs --> Wrapper["Monitoring result/error wrapper"]
    Wrapper --> Output["Client-visible result"]
```

The validation boundary limits the operation's inputs. The OS permission boundary
limits what the process can do. The result wrapper controls what monitoring
errors reveal. None of these provides a complete client authorization system.

## Implementation

| Boundary | Confirmed implementation | Limit |
| --- | --- | --- |
| Calculator input | Zod number fields for `a` and `b`. | Type checking is not identity verification or authorization. |
| Monitoring input | `z.strictObject({})` for each tool. | This strict rejection applies to the monitoring tools; health uses an empty raw-shape schema. |
| Disk target | `process.cwd()` selected internally. | The launcher controls the directory; this is not filesystem isolation. |
| Host operations | `node:os` and `statfs`; no command execution or file-content reads in monitoring. | Reads still run under the server's OS account and environment. |
| Monitoring errors | Fixed text with `isError: true`. | Successful output intentionally includes host details. |
| Transport | Local stdio entry point. | The project implements no authentication or remote HTTP service. |

Source: [src/monitoring-tools.ts](../../src/monitoring-tools.ts).

```ts
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
```

Annotations communicate expected behavior to clients. The function bodies and
runtime checks enforce the actual behavior; the hints do not grant permission
or prevent a future handler from being implemented incorrectly.

The injected reader parameters used by tests are internal interfaces. MCP callers
cannot submit a function, shell command, arbitrary filesystem path, or alternate
reader through the three strict empty schemas.

Success reveals `hostname`, platform/architecture, kernel/runtime versions,
memory and disk capacity, and the working directory. It does not intentionally
return environment variables or credentials. Monitoring failures omit the raw
error, but the existing entry-point startup catch logs startup errors to stderr.
Do not describe that separate startup logging as a universally sanitized logger.

## Commands

```sh
npm run build
node dist/index.js
```

Launch from a deliberately chosen working directory under an account with
appropriate access. Configure a trusted MCP client to start the direct Node
command. No privileged launch, token, cloud account, or shell integration is
required by this implementation.

If you use [Inspector](../lab-01-mcp-fundamentals.md#optional-mcp-inspector), follow
its local access controls and avoid sharing connection tokens or screenshots
containing sensitive host metadata.

## Verification

The [monitoring tests](../../test/monitoring.test.mjs) inject thrown errors
containing a fake private path and token, then assert exact safe result content
and no structured result. Another case submits `{ path: "/arbitrary" }` to all
three monitoring tools and checks that validation rejects it before any reader
runs. Those checks cover input rejection and error disclosure for the implemented
paths; they do not constitute a penetration test or OS isolation guarantee.

The recorded [six-test local success](../README.md#verification) followed a
subprocess failure inside the execution sandbox. These are distinct environment
results, not evidence that restrictions should be removed in production.

## Troubleshooting

A fixed `Unable to read ...` message is intentional. Diagnose locally using
permissions, launch directory, platform support, and calculation constraints;
do not expose raw internal exceptions merely to make a remote caller's error
more detailed. See [monitoring troubleshooting](../troubleshooting.md#monitoring-results-and-generic-errors).

## Security

Keep the operation set small and connect trusted clients. Read-only access can
still disclose operational metadata. Treat returned data as data when presenting
it to an AI host; it should not become a new instruction or a reason to grant
additional capabilities. The repository contains no prompt-injection defense,
access-policy engine, audit log, or network authentication mechanism.

## DevOps relevance

A narrow diagnostic interface is easier to reason about than arbitrary shell
access. Process identity, launch configuration, input validation, and output
handling all contribute to operational control. Adding remediation later would
require its own explicit permissions and failure analysis.

## Lessons learned

Read-only describes effects, not confidentiality. State intentional disclosures,
avoid client-selected paths, test validation before execution, and distinguish
sanitized tool failures from other logs and host controls.
