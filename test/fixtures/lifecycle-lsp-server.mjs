import { appendFileSync } from "node:fs";

const [label, logPath] = process.argv.slice(2);
const record = (event) => appendFileSync(logPath, `${event} ${label} ${process.pid}\n`);

record("START");

let input = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function respond(message, result) {
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
}

function handle(message) {
  switch (message.method) {
    case "initialize":
      respond(message, {
        capabilities: {
          textDocumentSync: 1,
          diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
          documentFormattingProvider: true,
        },
        serverInfo: { name: `lifecycle-${label}`, version: "1" },
      });
      break;
    case "textDocument/diagnostic":
      respond(message, {
        kind: "full",
        items: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 2,
          source: `lifecycle-${label}`,
          message: `definition-${label}`,
        }],
      });
      break;
    case "textDocument/formatting":
      respond(message, [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: `// formatted-${label}\n`,
      }]);
      break;
    case "shutdown":
      respond(message, null);
      break;
    case "exit":
      record("STOP");
      process.exit(0);
      break;
    default:
      if (message.id !== undefined) respond(message, null);
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (input.length < bodyStart + length) return;
    const body = input.subarray(bodyStart, bodyStart + length).toString("utf8");
    input = input.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});

process.on("SIGTERM", () => {
  record("TERM");
  process.exit(0);
});
