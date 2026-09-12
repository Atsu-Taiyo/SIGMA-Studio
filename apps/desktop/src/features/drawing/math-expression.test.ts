import { describe, expect, it } from "vitest";

import {
  compileMathExpression,
  evaluateMathEquation,
  evaluateMathExpression,
} from "./math-expression";

describe("safe mathematical expression evaluation", () => {
  it("evaluates 3D coordinates and arbitrary teaching parameters without dynamic code execution", () => {
    expect(evaluateMathExpression(
      "sqrt(x^2 + y^2 + z^2) + s",
      { x: 1, y: 2, z: 2, s: 0.5 },
    )).toBeCloseTo(3.5);
    expect(evaluateMathExpression("2u cos(v)", { u: 3, v: Math.PI })).toBeCloseTo(-6);
  });

  it("evaluates an equation as left minus right", () => {
    expect(evaluateMathEquation("x + y = 1", { x: 0.25, y: 0.75 })).toBeCloseTo(0);
    expect(evaluateMathEquation("z = s", { z: 0.4, s: 0.25 })).toBeCloseTo(0.15);
  });

  it.each([
    "globalThis.process.exit()",
    "constructor.constructor(1)",
    "x = 1 = 2",
    "sin(",
    "1 / 0",
  ])("rejects unsafe, malformed, or non-finite input: %s", (expression) => {
    expect(() => evaluateMathEquation(expression, { x: 1 })).toThrow();
  });

  it("bounds expression size and recursive nesting", () => {
    expect(() => evaluateMathExpression("1+".repeat(3_000) + "1")).toThrow(/long|complex/i);
    expect(() => evaluateMathExpression("-".repeat(300) + "1")).toThrow(/complex/i);
  });
});

describe("compiled expressions", () => {
  it("compiles once and evaluates against different scopes", () => {
    const compiled = compileMathExpression("x^2 + y");
    expect(compiled({ x: 3, y: 1 })).toBe(10);
    expect(compiled({ x: 0.5, y: -0.25 })).toBeCloseTo(0);
  });

  it("returns the same compiled function for the same source", () => {
    expect(compileMathExpression("sin(t)")).toBe(compileMathExpression("sin(t)"));
  });

  it("reports a syntax error every time, not only on the first attempt", () => {
    expect(() => compileMathExpression("2 +")).toThrow();
    expect(() => compileMathExpression("2 +")).toThrow();
  });

  it("keeps non-finite results an evaluation error, not a compile error", () => {
    const compiled = compileMathExpression("1 / x");
    expect(compiled({ x: 2 })).toBe(0.5);
    expect(() => compiled({ x: 0 })).toThrow(/non-finite/i);
  });

  it("rejects a referenced variable that is not a finite number", () => {
    const compiled = compileMathExpression("x + 1");
    expect(() => compiled({ x: Number.NaN })).toThrow(/Invalid variable x/);
    // 参照していない名前は評価に関係しない。
    expect(compiled({ x: 1, unused: Number.NaN })).toBe(2);
  });

  it("does not resolve inherited object properties as variables or functions", () => {
    expect(() => evaluateMathExpression("constructor")).toThrow();
    expect(() => evaluateMathExpression("toString(1)")).toThrow(/Unknown function/);
    expect(() => evaluateMathExpression("hasOwnProperty(1)")).toThrow(/Unknown function/);
  });

  it("lets a variable shadow a built-in constant, as before", () => {
    expect(evaluateMathExpression("pi")).toBeCloseTo(Math.PI);
    expect(evaluateMathExpression("pi", { pi: 3 })).toBe(3);
  });
});
