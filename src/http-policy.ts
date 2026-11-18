// Local lab policy, shared by the server and clients. No DNS or remote URLs.
export const HTTP_HOST = "127.0.0.1";
export const HTTP_PORT = 3100;
export const HTTP_PATH = "/mcp";
export const HTTP_PROTOCOL_VERSION = "2026-07-28";
export const HTTP_BODY_LIMIT = 64 * 1024;
export const HTTP_REQUEST_MS = 5_000;
export const DEFAULT_HTTP_URL = `http://${HTTP_HOST}:${HTTP_PORT}${HTTP_PATH}`;

export function localHttpUrl(input: string): URL {
  // Check the spelling before URL normalization: reject credentials, alternate
  // numeric IP forms, encoded hosts, DNS names, queries, fragments and paths.
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/mcp$/.exec(input);
  if (!match || Number(match[1]) > 65535) throw new Error("Invalid local MCP endpoint.");
  return new URL(input);
}
