import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(
  process.env.CODEXDESK_LOCAL_UPDATE_DIR ||
    path.join("/tmp", "CodexDesk-canary-updates"),
);
const host = process.env.CODEXDESK_LOCAL_UPDATE_HOST || "127.0.0.1";
const port = Number(process.env.CODEXDESK_LOCAL_UPDATE_PORT || 4319);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid CODEXDESK_LOCAL_UPDATE_PORT: ${String(port)}`);
}

const contentTypes = new Map([
  [".json", "application/json; charset=utf-8"],
  [".zip", "application/zip"],
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${host}:${port}`);
    const relativePath = decodeURIComponent(requestUrl.pathname).replace(
      /^\/+/,
      "",
    );
    const filePath = path.resolve(root, relativePath || "feed.json");
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end("Forbidden\n");
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": body.length,
      "Content-Type":
        contentTypes.get(path.extname(filePath)) ||
        "application/octet-stream",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404).end("Not found\n");
  }
});

server.listen(port, host, () => {
  console.log(`Serving ${root}`);
  console.log(`Feed URL: http://${host}:${port}/feed.json`);
});
