/**
 * cli.js — what every npm script says before it does anything.
 *
 * The mark, drawn in text from the same geometry the SVG uses, then the name,
 * the part number, the version and what this particular command is about to
 * do. It is the one place a person finds out which project they are standing
 * in and which generation of silicon is loaded.
 *
 * Colour is switched off when the output is not a terminal, so piping a build
 * into a file or a CI log does not fill it with escape codes. NO_COLOR is
 * honoured because it is the convention and costs one line.
 */

"use strict";

var pkg = require("../package.json");

var tty = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
var C = {
  lid: tty ? "\u001b[38;5;250m" : "",
  wall: tty ? "\u001b[38;5;238m" : "",
  lead: tty ? "\u001b[38;5;244m" : "",
  dot: tty ? "\u001b[38;5;46m" : "",
  legend: tty ? "\u001b[1;97m" : "",
  edge: tty ? "\u001b[38;5;85m" : "",
  set: tty ? "\u001b[38;5;29m" : "",
  name: tty ? "\u001b[1;97m" : "",
  dim: tty ? "\u001b[38;5;244m" : "",
  off: tty ? "\u001b[0m" : "",
};

/**
 * The part, in text.
 *
 * A package seen from slightly above: the lid on top carrying the pin-one dot
 * and the name, the front face of the body below it in a darker value, and
 * leads down both sides. The two values are the whole trick — a terminal has
 * no perspective, but it does have contrast, and contrast is what tells you
 * one surface faces up and the other faces you.
 */
function markRows() {
  var L = function (t) { return C.lid + t + C.off; };
  var W = function (t) { return C.wall + t + C.off; };
  var P = function (t) { return C.lead + t + C.off; };
  return [
    " " + L("▄▄▄▄▄▄▄▄▄▄▄▄") + " ",
    P("╺") + L("█") + C.dot + "▄" + C.off + L("██████████") + P("╸"),
    " " + L("████████████") + " ",
    P("╺") + L("██") + C.legend + "STEPPER" + C.off + L("███") + P("╸"),
    " " + L("████████████") + " ",
    P("╺") + W("████████████") + P("╸"),
    " " + P("▀ ▀ ▀ ▀ ▀ ▀ ") + " ",
  ];
}

/**
 * Print the header.
 * @param {string} task   the short name of what is running
 * @param {string} detail one line on what that means
 */
function header(task, detail) {
  var rows = markRows();
  var text = [
    C.name + "STEPPER" + C.off + C.dim + "  " + (pkg.part || "ST-8") +
      "  v" + pkg.version + C.off,
    C.dim + (pkg.tagline || "the chain is the clock") + C.off,
    "",
    C.edge + task + C.off + C.dim + "  " + detail + C.off,
  ];
  /* Centred against the part, so the block reads as a label on it. */
  var top = Math.max(0, Math.floor((rows.length - text.length) / 2));
  console.log("");
  for (var i = 0; i < rows.length; i++) {
    var line = i >= top && i - top < text.length ? text[i - top] : "";
    console.log("  " + rows[i] + "   " + line);
  }
  console.log("");
}

/** A closing line with how long it took, so a slow build is visible as slow. */
function done(t0, note) {
  var secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(C.dim + "  " + (note || "done") + " in " + secs + " s" + C.off + "\n");
}

module.exports = { header: header, done: done, colour: C };
