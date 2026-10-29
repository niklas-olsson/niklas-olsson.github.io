// SPDX-License-Identifier: Apache-2.0
// A loopback-only Wisp v1 test fixture. It forwards only the named test host
// to its own ephemeral HTTP/TLS ports; this is not a deployable proxy server.
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import { createHash } from "node:crypto";

export async function createRelayFixture({ key, cert }) {
  const connections = new Set();
  const upstreams = new Set();
  const heldResponses = new Set();
  const requests = [];
  let acceptedSockets = 0;
  const target = createHttpServer((request, response) => {
    // An intentionally unfinished, bounded response proves that World off
    // tears down an existing upstream stream, as well as denying new ones.
    if (request.url === "/hold") {
      heldResponses.add(response);
      response.once("close", () => heldResponses.delete(response));
      response.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": "32768",
        Connection: "close",
      });
      response.write("Terrarium held TCP response.\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/plain",
      Connection: "close",
    });
    response.end("Terrarium TCP over secure Wisp is real.\n");
  });
  const server = createServer({ key, cert }, (request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/plain",
      Connection: "close",
    });
    response.end("Terrarium TLS over Wisp is real.\n");
  });
  server.on("upgrade", (request, socket) => {
    if (request.url !== "/wisp" || !request.headers["sec-websocket-key"]) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(
        request.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    acceptedSockets++;
    connections.add(socket);
    const streams = new Map();
    let buffer = Buffer.alloc(0);

    function websocket(payload, opcode = 2) {
      if (socket.destroyed) return;
      const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
      header[0] = 0x80 | opcode;
      if (payload.length < 126) header[1] = payload.length;
      else {
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      }
      socket.write(Buffer.concat([header, payload]));
    }

    function wisp(type, id, payload) {
      const packet = Buffer.alloc(5 + payload.length);
      packet[0] = type;
      packet.writeUInt32LE(id, 1);
      payload.copy(packet, 5);
      websocket(packet);
    }

    function credit(id) {
      const value = Buffer.alloc(4);
      value.writeUInt32LE(65536);
      wisp(3, id, value);
    }
    credit(0);

    function dispatch(frame) {
      if (frame.length < 5) throw new Error("Truncated Wisp test packet.");
      const type = frame[0];
      const id = frame.readUInt32LE(1);
      if (type === 1) {
        const hostname = frame.subarray(8).toString("utf8");
        const port = frame.readUInt16LE(6);
        if (
          frame[5] !== 1 ||
          hostname !== "fixture.example" ||
          ![target.address().port, server.address().port].includes(port)
        )
          throw new Error(
            "The test relay accepts only its own HTTP/TLS fixtures.",
          );
        requests.push({ hostname, port });
        const upstream = connect({ host: "127.0.0.1", port });
        streams.set(id, upstream);
        upstreams.add(upstream);
        upstream.on("data", (data) => {
          for (let offset = 0; offset < data.length; offset += 16000)
            wisp(2, id, data.subarray(offset, offset + 16000));
        });
        upstream.on("end", () => wisp(4, id, Buffer.from([2])));
        upstream.on("error", () => wisp(4, id, Buffer.from([3])));
        upstream.on("close", () => {
          streams.delete(id);
          upstreams.delete(upstream);
        });
        credit(id);
      } else if (type === 2) streams.get(id)?.write(frame.subarray(5));
      else if (type === 4) streams.get(id)?.destroy();
    }

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (buffer.length > 1024 * 1024)
          throw new Error("Oversize WebSocket test message.");
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 15;
          let length = buffer[1] & 127;
          let offset = 2;
          if (!(buffer[0] & 0x80) || !(buffer[1] & 0x80))
            throw new Error("Unexpected WebSocket framing.");
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          }
          if (length === 127)
            throw new Error("Oversize WebSocket test message.");
          if (buffer.length < offset + 4 + length) return;
          const mask = buffer.subarray(offset, offset + 4);
          offset += 4;
          const payload = Buffer.from(buffer.subarray(offset, offset + length));
          for (let index = 0; index < payload.length; index++)
            payload[index] ^= mask[index % 4];
          buffer = buffer.subarray(offset + length);
          if (opcode === 8) {
            websocket(payload, 8);
            socket.end();
            return;
          }
          if (opcode === 9) websocket(payload, 10);
          if (opcode === 2) dispatch(payload);
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      connections.delete(socket);
      for (const upstream of streams.values()) upstream.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `wss://localhost:${server.address().port}/wisp`,
    guestUrl: `http://fixture.example:${target.address().port}/proof`,
    heldGuestUrl: `http://fixture.example:${target.address().port}/hold`,
    guestTlsUrl: `https://fixture.example:${server.address().port}/proof`,
    requests,
    get acceptedSockets() {
      return acceptedSockets;
    },
    get activeSockets() {
      return connections.size;
    },
    get activeUpstreams() {
      return upstreams.size;
    },
    get heldRequests() {
      return heldResponses.size;
    },
    close: async () => {
      for (const socket of connections) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      for (const response of heldResponses) response.destroy();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => target.close(resolve));
    },
  };
}
