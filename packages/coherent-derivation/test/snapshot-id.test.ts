import { describe, expect, it } from "vitest";
import { SnapshotIssuer } from "../src/internal/snapshot-id.js";

describe("SnapshotIssuer", () => {
  it("mints monotonically-increasing ids from 1", () => {
    const issuer = new SnapshotIssuer();
    expect(issuer.next()).toBe("snap-1");
    expect(issuer.next()).toBe("snap-2");
    expect(issuer.next()).toBe("snap-3");
  });

  it("uses a custom prefix when supplied", () => {
    const issuer = new SnapshotIssuer("test");
    expect(issuer.next()).toBe("test-1");
    expect(issuer.next()).toBe("test-2");
  });

  it("isolates counters across separate issuers", () => {
    const a = new SnapshotIssuer("a");
    const b = new SnapshotIssuer("b");
    expect(a.next()).toBe("a-1");
    expect(b.next()).toBe("b-1");
    expect(a.next()).toBe("a-2");
    expect(b.next()).toBe("b-2");
  });

  it("never collides within a single issuer over many issuances", () => {
    const issuer = new SnapshotIssuer();
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      const id = issuer.next();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(10_000);
  });
});
