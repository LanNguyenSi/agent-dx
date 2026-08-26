export const it = (_name: string, fn: () => number) => fn();

it("a plain helper that happens to be called it", () => {
  return 1;
});
