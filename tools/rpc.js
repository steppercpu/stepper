/**
 * rpc.js: a JSON-RPC client that gets to the chain anyway.
 *
 * Why this exists rather than `fetch`.
 *
 * The endpoint in config.js is a real host behind Cloudflare, but at least one
 * consumer ISP (Biznet, in Indonesia) answers a lookup for it with its own
 * block page instead of the real address:
 *
 *     $ nslookup rpc.mainnet.chain.robinhood.com
 *     Name:    rpz.biznet          <- not the chain
 *     $ nslookup rpc.mainnet.chain.robinhood.com 8.8.8.8
 *     Name:    customer-origin.offchainlabs.com   <- the chain
 *
 * A deploy script that dies on somebody's ISP is not a deploy script. So the
 * name is resolved over DNS-over-HTTPS first, and the connection is made to
 * the address that comes back with the hostname pinned as the TLS server name.
 * The certificate is still checked against the real hostname, so this routes
 * around a hijacked resolver without weakening anything.
 *
 * Set STEPPER_NO_DOH=1 to use the system resolver instead.
 */
"use strict";

const https = require("https");

const DOH = "https://cloudflare-dns.com/dns-query";

/** name -> [ip], cached for the life of the process. */
const cache = new Map();

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

/**
 * Resolve through Cloudflare's DoH endpoint, following the CNAME chain the
 * answer section already contains rather than making a second query for it.
 */
async function resolve(hostname) {
  if (process.env.STEPPER_NO_DOH === "1") return [hostname];
  if (cache.has(hostname)) return cache.get(hostname);

  const url = DOH + "?name=" + encodeURIComponent(hostname) + "&type=A";
  const r = await get(url, { accept: "application/dns-json" });
  if (r.status !== 200) throw new Error("DoH lookup failed: HTTP " + r.status);

  const j = JSON.parse(r.body);
  const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
  if (!ips.length) throw new Error("DoH returned no A record for " + hostname);

  cache.set(hostname, ips);
  return ips;
}

function post(ip, hostname, path, payload) {
  return new Promise((resolve_, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      host: ip,
      servername: hostname,          // SNI and certificate check, both real
      port: 443,
      path: path || "/",
      method: "POST",
      timeout: 30000,
      headers: {
        Host: hostname,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": "stepper-deploy",
      },
    }, (res) => {
      let out = "";
      res.on("data", (d) => { out += d; });
      res.on("end", () => resolve_({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * A client bound to one endpoint.
 *
 * @param {string} url e.g. https://rpc.mainnet.chain.robinhood.com
 */
function client(url) {
  const u = new URL(url);
  let id = 0;

  /** One JSON-RPC call. Throws on a JSON-RPC error rather than returning it. */
  async function call(method, params) {
    const ips = await resolve(u.hostname);
    let last = null;
    // Every address the resolver gave back, in order, before giving up.
    for (const ip of ips) {
      try {
        const r = await post(ip, u.hostname, u.pathname + u.search, {
          jsonrpc: "2.0", id: ++id, method, params: params || [],
        });
        if (r.status !== 200) { last = new Error("HTTP " + r.status); continue; }
        const j = JSON.parse(r.body);
        if (j.error) {
          const e = new Error(j.error.message || "rpc error");
          e.code = j.error.code;
          e.data = j.error.data;
          throw e;                     // a real answer, just not a happy one
        }
        return j.result;
      } catch (e) {
        if (e.code !== undefined) throw e;
        last = e;
      }
    }
    throw last || new Error("no route to " + u.hostname);
  }

  const num = async (m, p) => BigInt(await call(m, p));

  return {
    url,
    call,
    chainId: () => num("eth_chainId"),
    blockNumber: () => num("eth_blockNumber"),
    gasPrice: () => num("eth_gasPrice"),
    balance: (a) => num("eth_getBalance", [a, "latest"]),
    nonce: (a) => num("eth_getTransactionCount", [a, "pending"]),
    code: (a) => call("eth_getCode", [a, "latest"]),
    estimateGas: (tx) => num("eth_estimateGas", [tx]),
    ethCall: (tx) => call("eth_call", [tx, "latest"]),
    send: (raw) => call("eth_sendRawTransaction", [raw]),
    receipt: (h) => call("eth_getTransactionReceipt", [h]),

    /** Poll until the transaction is mined, or give up loudly. */
    async wait(hash, timeoutMs) {
      const until = Date.now() + (timeoutMs || 180000);
      for (;;) {
        const r = await this.receipt(hash);
        if (r) return r;
        if (Date.now() > until) throw new Error("timed out waiting for " + hash);
        await new Promise((s) => setTimeout(s, 2000));
      }
    },
  };
}

module.exports = { client, resolve };
