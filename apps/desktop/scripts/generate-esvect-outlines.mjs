#!/usr/bin/env node
// Generates src/lib/esvect-d-outlines.ts from vect10.pfb of the esvect package
// (CTAN: macros/latex/contrib/esvect, https://ctan.org/pkg/esvect).
//
//   node scripts/generate-esvect-outlines.mjs path/to/esvect/pfb/vect10.pfb
//
// The arrow of `\vv` with option d is esvect's \fldr = slot '024; its line is
// drawn with the rules '043 (start) and '040 (\cleaders fill). The outlines
// are read from the Type 1 font and written in a stretchy two-slice form; see
// src/lib/esvect.ts. The output is GPL-licensed data (THIRD_PARTY_NOTICES.md).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEAD = 0o24;
const TAIL = 0o43;
const FILL = 0o40;
const MU = 1000 / 18; // 1mu in font units (1000 per em)
const WIDTH = 400000; // slice viewBox width, as MathLive's stretchy SVGs

/** PFB segments → cleartext and eexec-decrypted private part (Adobe Type 1 spec, ch. 7). */
function readType1(file) {
  const bytes = readFileSync(file);
  const ascii = [];
  const binary = [];
  for (let at = 0; at < bytes.length;) {
    if (bytes[at] !== 0x80) throw new Error("Not a PFB file");
    const type = bytes[at + 1];
    if (type === 3) break;
    const length = bytes.readUInt32LE(at + 2);
    const data = bytes.subarray(at + 6, at + 6 + length);
    (type === 1 ? ascii : binary).push(data);
    at += 6 + length;
  }
  return { clear: Buffer.concat(ascii).toString("latin1"), encrypted: decrypt(Buffer.concat(binary), 55665, 4) };
}

function decrypt(data, key, skip) {
  const out = Buffer.alloc(data.length);
  let r = key;
  for (let i = 0; i < data.length; i += 1) {
    out[i] = data[i] ^ (r >> 8);
    r = ((data[i] + r) * 52845 + 22719) & 0xffff;
  }
  return out.subarray(skip);
}

function parseFont(file) {
  const { clear, encrypted } = readType1(file);
  const encoding = new Map([...clear.matchAll(/dup (\d+) \/(\S+) put/g)].map((m) => [Number(m[1]), m[2]]));
  const text = encrypted.toString("latin1");
  const lenIV = Number(/\/lenIV (\d+)/.exec(text)?.[1] ?? 4);
  const binaryAfter = (token, start) => {
    const length = Number(token);
    return encrypted.subarray(start, start + length);
  };
  const subrs = [];
  for (const m of text.matchAll(/dup (\d+) (\d+) (?:RD|-\|) /g)) {
    subrs[Number(m[1])] = decrypt(binaryAfter(m[2], m.index + m[0].length), 4330, lenIV);
  }
  const charStart = text.indexOf("/CharStrings");
  const glyphs = new Map();
  for (const m of text.slice(charStart).matchAll(/\/(\S+) (\d+) (?:RD|-\|) /g)) {
    glyphs.set(m[1], decrypt(binaryAfter(m[2], charStart + m.index + m[0].length), 4330, lenIV));
  }
  return { encoding, subrs, glyphs };
}

/** Type 1 charstring → absolute contours of [op, ...points] (moveTo, lineTo, curveTo). */
function outline(font, code) {
  const program = font.glyphs.get(font.encoding.get(code));
  if (!program) throw new Error(`No glyph for slot ${code.toString(8)}`);
  const contours = [];
  let x = 0;
  let y = 0;
  let advance = 0;
  let stack = [];
  let flex = null;
  const ps = [];
  const moveTo = () => contours.push([["M", x, y]]);
  const lineTo = () => contours.at(-1).push(["L", x, y]);
  const curve = (dx1, dy1, dx2, dy2, dx3, dy3) => {
    const c1 = [x + dx1, y + dy1];
    const c2 = [c1[0] + dx2, c1[1] + dy2];
    x = c2[0] + dx3; y = c2[1] + dy3;
    contours.at(-1).push(["C", ...c1, ...c2, x, y]);
  };
  const run = (code) => {
    for (let i = 0; i < code.length;) {
      const v = code[i++];
      if (v >= 32) {
        if (v <= 246) stack.push(v - 139);
        else if (v <= 250) stack.push((v - 247) * 256 + code[i++] + 108);
        else if (v <= 254) stack.push(-(v - 251) * 256 - code[i++] - 108);
        else { stack.push(code.readInt32BE(i)); i += 4; }
        continue;
      }
      switch (v) {
        case 13: x = stack[0]; y = 0; advance = stack[1]; break; // hsbw
        case 21: if (flex) { flex.push([x += stack[0], y += stack[1]]); } else { x += stack[0]; y += stack[1]; moveTo(); } break;
        case 22: if (flex) { flex.push([x += stack[0], y]); } else { x += stack[0]; moveTo(); } break;
        case 4: if (flex) { flex.push([x, y += stack[0]]); } else { y += stack[0]; moveTo(); } break;
        case 5: x += stack[0]; y += stack[1]; lineTo(); break;
        case 6: x += stack[0]; lineTo(); break;
        case 7: y += stack[0]; lineTo(); break;
        case 8: curve(...stack.slice(0, 6)); break;
        case 30: curve(0, stack[0], stack[1], stack[2], stack[3], 0); break; // vhcurveto
        case 31: curve(stack[0], 0, stack[1], stack[2], 0, stack[3]); break; // hvcurveto
        case 9: break; // closepath (contours are closed when drawn)
        case 10: { const index = stack.pop(); const rest = stack; stack = rest; run(font.subrs[index]); continue; }
        case 11: return;
        case 14: return;
        case 1: case 3: break; // hstem, vstem
        case 12: {
          const op = code[i++];
          if (op === 12) { const b = stack.pop(); const a = stack.pop(); stack.push(a / b); continue; } // div
          if (op === 16) { // callothersubr
            const other = stack.pop();
            const count = stack.pop();
            const args = stack.splice(stack.length - count, count);
            if (other === 1) { flex = []; }
            else if (other === 0 && flex) {
              const [, p1, p2, p3, p4, p5, p6] = flex; // flex[0] is the reference point
              flex = null;
              contours.at(-1).push(["C", ...p1, ...p2, ...p3], ["C", ...p4, ...p5, ...p6]);
              [x, y] = p6;
              ps.push(y, x);
            } else if (other === 3) ps.push(3);
            else ps.push(...args.reverse());
            continue;
          }
          if (op === 17) { stack.push(ps.pop()); continue; } // pop
          if (op === 33) { x = stack[0]; y = stack[1]; break; } // setcurrentpoint
          if (op === 7) { x = stack[0]; y = stack[1]; advance = stack[2]; break; } // sbw
          break; // dotsection, vstem3, hstem3
        }
        default: throw new Error(`Unsupported charstring operator ${v}`);
      }
      stack = [];
    }
  };
  run(program);
  return { contours, advance };
}

/** Exact bounds, including cubic extrema. */
function bounds(contours) {
  let [minY, maxY] = [Infinity, -Infinity];
  for (const contour of contours) {
    let py = contour[0][2];
    for (const [op, ...p] of contour) {
      const ys = op === "C" ? [py, p[5]] : [p[1]];
      if (op === "C") {
        const [a, b, c, d] = [py, p[1], p[3], p[5]];
        const [qa, qb, qc] = [-a + 3 * b - 3 * c + d, 2 * (a - 2 * b + c), b - a];
        const roots = Math.abs(qa) < 1e-12 ? (qb ? [-qc / qb] : [])
          : (() => { const disc = qb * qb - 4 * qa * qc; return disc < 0 ? [] : [(-qb + Math.sqrt(disc)) / (2 * qa), (-qb - Math.sqrt(disc)) / (2 * qa)]; })();
        for (const t of roots.filter((t) => t > 0 && t < 1)) {
          const u = 1 - t;
          ys.push(u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d);
        }
      }
      for (const value of ys) { minY = Math.min(minY, value); maxY = Math.max(maxY, value); }
      py = p.at(-1);
    }
  }
  return { minY, maxY };
}

const n = (value) => String(Number(value.toFixed(2)));

/** Font units (y up) → slice units (y down from the head's ink top), shifted by dx. */
function pathData(contours, dx, top) {
  return contours.map((contour) => contour.map(([op, ...p]) => op + p.map((v, i) => n(i % 2 ? top - v : v + dx)).join(" ")).join("") + "Z").join("");
}

function rule(x0, x1, y0, y1, top) {
  return `M${n(x0)} ${n(top - y1)}H${n(x1)}V${n(top - y0)}H${n(x0)}Z`;
}

const [, , pfb] = process.argv;
if (!pfb) {
  console.error("usage: node scripts/generate-esvect-outlines.mjs path/to/vect10.pfb");
  process.exit(1);
}
const font = parseFont(pfb);
const head = outline(font, HEAD);
const tail = outline(font, TAIL);
const fill = outline(font, FILL);
const { minY: headBottom, maxY: top } = bounds(head.contours);
const { minY: ruleBottom, maxY: ruleTop } = bounds(fill.contours);
// The fill rule's straight part (its round ends overlap the neighbours).
const [stemLow, stemHigh] = [Math.round(ruleBottom + (ruleTop - ruleBottom - 40) / 2), Math.round(ruleBottom + (ruleTop - ruleBottom - 40) / 2) + 40];
const tailX = 2 * MU;
const headX = WIDTH - head.advance;
const naturalWidth = 2 * MU + tail.advance - 3 * MU + head.advance;

const source = `/**
 * Arrow outlines for \`\\vv\` (lib/esvect.ts), derived from vect10.pfb of the
 * esvect package v1.3 by Eddie Saudrais (Type 1 version of its METAFONT
 * fonts by Olivier Crouzet), CTAN macros/latex/contrib/esvect. Licensed under
 * the GNU General Public License; see THIRD_PARTY_NOTICES.md.
 *
 * Generated by scripts/generate-esvect-outlines.mjs. Do not edit by hand.
 * Slots: head '024 (option d), start rule '043, fill rule '040.
 * Units: 1 = 0.001em; y grows downward from the head's ink top.
 */
export const ESVECT_D_VIEWBOX_HEIGHT = ${n(top - headBottom)};
/** The head's ink top above the arrow row's baseline (font units). */
export const ESVECT_D_HEAD_TOP = ${n(top)};
/** The arrow row's natural width: 2mu + start rule − 1.5mu − 1.5mu + head (font units). */
export const ESVECT_D_NATURAL_WIDTH = ${n(naturalWidth)};
/** Left half (xMinYMin): the start rule at 2mu, then the line to the far right. */
export const ESVECT_D_LEFT_SLICE_PATHS: readonly string[] = ${JSON.stringify([pathData(tail.contours, tailX, top), rule(tailX + 150, WIDTH, stemLow, stemHigh, top)])};
/** Right half (xMaxYMin): the line from the far left, then the head flush right. */
export const ESVECT_D_RIGHT_SLICE_PATHS: readonly string[] = ${JSON.stringify([rule(0, headX + 150, stemLow, stemHigh, top), pathData(head.contours, headX, top)])};
`;
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/esvect-d-outlines.ts");
writeFileSync(out, source);
console.log(`wrote ${path.relative(process.cwd(), out)}: head ${n(headBottom)}..${n(top)}, rule ${stemLow}..${stemHigh}`);
