// Arrow function assigned to a const — covered by pass 1's VariableStatement path.
export const incr = (x: number): number => x + 1;

// FunctionExpression assigned to a const — same path, different syntax kind.
export const decr = function (x: number): number {
  return x - 1;
};
