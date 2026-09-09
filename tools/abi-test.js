#!/usr/bin/env node
/**
 * abi-test.js — the browser's encoder against an independent one.
 *
 *   npm run abi
 *
 * public/scripts/abi-encode.js builds the calldata a wallet signs. If it is
 * wrong the wallet still signs it, the chain still accepts it, and the
 * transaction does something other than what the page said it would. There is
 * no way to notice that by looking at the page, so it is checked here against
 * ethers, which is already a dev dependency and was written by somebody else.
 *
 * The case that matters is the nested one: offsets inside a tuple are measured
 * from the tuple, not from the start of the call, and a codec that gets that
 * wrong produces a perfectly valid transaction carrying a struct shifted by
 * however many bytes came before it.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const cli = require("./cli.js");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");

cli.header("ABI", "the page's encoder against an independent one");

/* The browser file, loaded the way the browser loads it. */
const win = { TextEncoder: TextEncoder };
new Function("window", "TextEncoder",
  fs.readFileSync(path.join(ROOT, "public/scripts/abi-encode.js"), "utf8")
)(win, TextEncoder);
const ABI = win.ABI;

let bad = 0;

/** Our type spec, as the string ethers wants. */
function asEthers(t) {
  if (t && typeof t === "object" && t.tuple) {
    return "tuple(" + t.tuple.map(asEthers).join(",") + ")";
  }
  return t;
}

function check(name, types, values) {
  let mine, theirs;
  try {
    mine = ABI.encode(types, values);
  } catch (e) {
    console.log("  FAIL  " + name.padEnd(46) + "threw: " + e.message);
    bad++;
    return;
  }
  try {
    theirs = ethers.AbiCoder.defaultAbiCoder()
      .encode(types.map(asEthers), values).replace(/^0x/, "");
  } catch (e) {
    console.log("  FAIL  " + name.padEnd(46) + "reference threw: " + e.message);
    bad++;
    return;
  }
  const ok = mine === theirs;
  console.log("  " + (ok ? "pass" : "FAIL") + "  " + name.padEnd(46) +
    (mine.length / 2) + " bytes");
  if (!ok) {
    bad++;
    for (let i = 0; i < Math.max(mine.length, theirs.length); i += 64) {
      const a = mine.substr(i, 64), b = theirs.substr(i, 64);
      if (a !== b) {
        console.log("        word " + (i / 64) + " ours   " + a);
        console.log("        word " + (i / 64) + " theirs " + b);
      }
    }
  }
}

const ADDR = "0x0C37b19D1c6d2301C4F2a905C0ba5A82d02CFBcE";
const B32 = "0x" + "11".repeat(32);

check("one address", ["address"], [ADDR]);
check("uint256 and bool", ["uint256", "bool"], [12345n, true]);
check("uint16 at its ceiling", ["uint16"], [65535]);
check("bytes32", ["bytes32"], [B32]);
check("an empty string", ["string"], [""]);
check("a short string", ["string"], ["Ledger Chip"]);
check("a string that spills a word", ["string"], ["x".repeat(33)]);
check("a string with non-ASCII in it", ["string"], ["Chip éè — µ"]);
check("empty bytes", ["bytes"], ["0x"]);
check("bytes that spill a word", ["bytes"], ["0x" + "ab".repeat(40)]);
check("static before dynamic", ["address", "string"], [ADDR, "after"]);
check("dynamic before static", ["string", "address"], ["before", ADDR]);
check("two dynamics", ["string", "bytes"], ["one", "0xdeadbeef"]);

const SOCIALS = { tuple: ["string", "string", "string", "string", "string"] };
check("a tuple of five strings", [SOCIALS],
  [["x.com/a", "t.me/a", "discord.gg/a", "a.example", "fc/a"]]);

const PARAMS = {
  tuple: [
    "string", "string", "string", "string",
    SOCIALS,
    "address", "uint16", "bool", "bytes32", "bytes32",
  ],
};

/* The real call. Every earlier case exists to make this one debuggable. */
const romHex = "0x" + "12345678".repeat(9);
check("the launch call, exactly as the page sends it",
  ["bytes", PARAMS, "uint256", "address"],
  [
    romHex,
    [
      "Ledger Chip", "LEDG", "ipfs://bafyLogo", "adds what it is sent, for ever",
      ["x.com/ledger", "t.me/ledger", "discord.gg/ledger", "ledger.example", "fc/ledger"],
      ADDR, 200, false, B32, "0x" + "22".repeat(32),
    ],
    1n,
    "0x0000000000000000000000000000000000000000",
  ]);

check("the same call with every string empty",
  ["bytes", PARAMS, "uint256", "address"],
  [
    "0x",
    ["", "", "", "", ["", "", "", "", ""], ADDR, 0, true, B32, B32],
    0n,
    ADDR,
  ]);

/* A selector plus arguments is what actually goes on the wire. */
const sig = "launch(bytes,(string,string,string,string,(string,string,string,string,string)," +
  "address,uint16,bool,bytes32,bytes32),uint256,address)";
const selector = ethers.id(sig).slice(0, 10);
console.log("");
console.log("  launch selector " + selector);

const factoryPath = path.join(ROOT, "contracts", "out", "ChipFactory.json");
if (fs.existsSync(factoryPath)) {
  const art = JSON.parse(fs.readFileSync(factoryPath, "utf8"));
  const iface = new ethers.Interface(art.abi);
  const fromAbi = iface.getFunction("launch").selector;
  const ok = fromAbi === selector;
  console.log("  " + (ok ? "pass" : "FAIL") +
    "  the selector matches the compiled ChipFactory".padEnd(50) + fromAbi);
  if (!ok) bad++;
} else {
  console.log("  (ChipFactory.json missing, so the selector was not cross-checked)");
}

console.log("");
if (bad) {
  console.log("  " + bad + " failing. The page would sign the wrong call.");
  process.exit(1);
}
console.log("  the page encodes what the contract expects");
process.exit(0);
