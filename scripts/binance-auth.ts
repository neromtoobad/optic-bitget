import http from "node:http";
import { exec } from "node:child_process";
import { beginAuth, finishAuth, LOCAL_CALLBACK, listBinanceTools, mcpStatus } from "../src/lib/binance/mcp.js";
import { config } from "../src/config.js";

// One-time operator authorisation for the Binance MCP Server, from a laptop:
//   npm run binance:auth
// Opens the Binance consent page, receives the code on 127.0.0.1:8976, exchanges
// it, and stores the tokens in DATABASE_PATH. The client id is the deployed
// metadata document, so BINANCE_OAUTH_CLIENT_METADATA_URL must be an https URL
// this service already serves (deploy first, then authorise).

const port = 8976;
const status = await mcpStatus();
console.error(`client_id: ${status.client_id}`);
if (status.authorized && !process.argv.includes("--force")) {
  console.error("already authorised (pass --force to re-authorise). tools:");
  console.error((await listBinanceTools())?.map((t) => `  ${t.name}`).join("\n") ?? "  (could not list — token may be stale, try --force)");
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end("not the callback");
    return;
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  try {
    if (err || !code) throw new Error(err ? `${err}: ${url.searchParams.get("error_description") ?? ""}` : "no code in callback");
    await finishAuth(code, state);
    res.writeHead(200, { "content-type": "text/plain" }).end("Optic is connected to Binance. You can close this tab.");
    console.error(`authorised — tokens stored in ${config.databasePath}`);
    const tools = await listBinanceTools();
    console.error(`MCP tools (${tools?.length ?? 0}):\n${(tools ?? []).map((t) => `  ${t.name} — ${(t.description ?? "").slice(0, 80)}`).join("\n")}`);
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" }).end(`authorisation failed: ${(e as Error).message}`);
    console.error(`authorisation failed: ${(e as Error).message}`);
    server.close();
    process.exit(1);
  }
});

server.listen(port, "127.0.0.1", async () => {
  try {
    const url = await beginAuth(LOCAL_CALLBACK, { force: true });
    if (!url) {
      console.error("already authorised via refresh token");
      process.exit(0);
    }
    console.error(`open this URL in your browser (logged in to Binance):\n\n${url}\n`);
    if (process.platform === "darwin") exec(`open "${url}"`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
});
