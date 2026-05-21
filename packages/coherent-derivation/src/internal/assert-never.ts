export function assertNever(value: never): never {
  throw new Error(
    `Unexpected discriminated union value: ${JSON.stringify(value)}`,
  );
}
