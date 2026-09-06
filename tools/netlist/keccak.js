/**
 * keccak.js — Keccak-256, so a function selector is derived rather than copied.
 *
 * Node ships SHA3-256, which is NIST's padding and produces a different digest
 * from the one Ethereum uses. Pasting a selector from somewhere else is how a
 * front end ends up calling a function that no longer exists, which is exactly
 * the bug this file was written to close: the site was carrying the selector
 * for a function called `tick`, and ours is called `step`.
 *
 * Verified against published vectors at the bottom of tools/build-contract.js.
 * If those ever fail, nothing downstream is written.
 */

"use strict";

var RC = [
  [0x00000000, 0x00000001], [0x00000000, 0x00008082], [0x80000000, 0x0000808a],
  [0x80000000, 0x80008000], [0x00000000, 0x0000808b], [0x00000000, 0x80000001],
  [0x80000000, 0x80008081], [0x80000000, 0x00008009], [0x00000000, 0x0000008a],
  [0x00000000, 0x00000088], [0x00000000, 0x80008009], [0x00000000, 0x8000000a],
  [0x00000000, 0x8000808b], [0x80000000, 0x0000008b], [0x80000000, 0x00008089],
  [0x80000000, 0x00008003], [0x80000000, 0x00008002], [0x80000000, 0x00000080],
  [0x00000000, 0x0000800a], [0x80000000, 0x8000000a], [0x80000000, 0x80008081],
  [0x80000000, 0x00008080], [0x00000000, 0x80000001], [0x80000000, 0x80008008],
];

var ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39,
  41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

// Derived from the definition rather than transcribed: for lane i = x + 5y the
// destination is y + 5*((2x + 3y) mod 5). Copying this table by hand is how a
// Keccak implementation quietly becomes a different hash function.
var PI = [0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4];

/** 64-bit lanes are held as [high, low] pairs of 32-bit halves. */
function rotl(x, n) {
  if (n === 0) return [x[0], x[1]];
  if (n < 32) {
    return [
      ((x[0] << n) | (x[1] >>> (32 - n))) >>> 0,
      ((x[1] << n) | (x[0] >>> (32 - n))) >>> 0,
    ];
  }
  n -= 32;
  if (n === 0) return [x[1], x[0]];
  return [
    ((x[1] << n) | (x[0] >>> (32 - n))) >>> 0,
    ((x[0] << n) | (x[1] >>> (32 - n))) >>> 0,
  ];
}

function permute(A) {
  var C = new Array(5), D = new Array(5), B = new Array(25);
  var x, y, i;
  for (var round = 0; round < 24; round++) {
    // theta
    for (x = 0; x < 5; x++) {
      C[x] = [
        (A[x][0] ^ A[x + 5][0] ^ A[x + 10][0] ^ A[x + 15][0] ^ A[x + 20][0]) >>> 0,
        (A[x][1] ^ A[x + 5][1] ^ A[x + 10][1] ^ A[x + 15][1] ^ A[x + 20][1]) >>> 0,
      ];
    }
    for (x = 0; x < 5; x++) {
      var r = rotl(C[(x + 1) % 5], 1);
      D[x] = [(C[(x + 4) % 5][0] ^ r[0]) >>> 0, (C[(x + 4) % 5][1] ^ r[1]) >>> 0];
    }
    for (i = 0; i < 25; i++) {
      A[i] = [(A[i][0] ^ D[i % 5][0]) >>> 0, (A[i][1] ^ D[i % 5][1]) >>> 0];
    }
    // rho and pi
    for (i = 0; i < 25; i++) B[PI[i]] = rotl(A[i], ROT[i]);
    // chi
    for (y = 0; y < 5; y++) {
      for (x = 0; x < 5; x++) {
        var a = B[y * 5 + x];
        var b = B[y * 5 + (x + 1) % 5];
        var c = B[y * 5 + (x + 2) % 5];
        A[y * 5 + x] = [
          (a[0] ^ (~b[0] & c[0])) >>> 0,
          (a[1] ^ (~b[1] & c[1])) >>> 0,
        ];
      }
    }
    // iota
    A[0] = [(A[0][0] ^ RC[round][0]) >>> 0, (A[0][1] ^ RC[round][1]) >>> 0];
  }
  return A;
}

/** Keccak-256 of a byte array, returned as lowercase hex. */
function keccak256(bytes) {
  var RATE = 136;                       // 1088 bits
  var A = [];
  for (var i = 0; i < 25; i++) A.push([0, 0]);

  // Keccak padding is 0x01 ... 0x80, not SHA-3's 0x06.
  var len = bytes.length;
  var padded = new Uint8Array(Math.ceil((len + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[len] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (var off = 0; off < padded.length; off += RATE) {
    for (var lane = 0; lane < RATE / 8; lane++) {
      var p = off + lane * 8;
      var lo = (padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) |
                (padded[p + 3] << 24)) >>> 0;
      var hi = (padded[p + 4] | (padded[p + 5] << 8) | (padded[p + 6] << 16) |
                (padded[p + 7] << 24)) >>> 0;
      A[lane] = [(A[lane][0] ^ hi) >>> 0, (A[lane][1] ^ lo) >>> 0];
    }
    A = permute(A);
  }

  var out = "";
  for (var k = 0; k < 4; k++) {
    var w = A[k];
    for (var byteIdx = 0; byteIdx < 4; byteIdx++) {
      out += ((w[1] >>> (byteIdx * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    for (byteIdx = 0; byteIdx < 4; byteIdx++) {
      out += ((w[0] >>> (byteIdx * 8)) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return out;
}

/** The first four bytes of keccak256 over a canonical function signature. */
function selector(signature) {
  var bytes = new Uint8Array(signature.length);
  for (var i = 0; i < signature.length; i++) bytes[i] = signature.charCodeAt(i);
  return "0x" + keccak256(bytes).slice(0, 8);
}

module.exports = { keccak256: keccak256, selector: selector };
