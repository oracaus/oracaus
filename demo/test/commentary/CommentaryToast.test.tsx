// @vitest-environment happy-dom

// Tests for the single-toast renderer. happy-dom + @testing-library/react
// cover the per-toast visual contract; the stack-level animation /
// positioning behaviour lives in `CommentaryToastStack.test.tsx`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CommentaryToast,
  type CommentaryToastInstance,
} from "../../src/components/CommentaryToast.js";

const BASE: CommentaryToastInstance = {
  id: "t1",
  instanceId: "t1#1",
  text: "Naive's queue at twelve.",
  tier: 4,
  dismissAtMs: 5_000,
};

describe("CommentaryToast — visual contract", () => {
  it("renders text + tier dot", () => {
    const { getByTestId } = render(<CommentaryToast toast={BASE} />);
    expect(getByTestId("commentary-toast-text").textContent).toBe(
      "Naive's queue at twelve.",
    );
    // Tier 4 → filled muted dot per TIER_DOT_CLASS.
    expect(getByTestId("commentary-toast-tier-dot").className).toContain(
      "bg-fg-muted",
    );
  });

  it("is `aria-hidden` — the toast is a visual-only narration surface", () => {
    const { getByTestId } = render(<CommentaryToast toast={BASE} />);
    expect(getByTestId("commentary-toast").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("renders a tier-tint overlay span for T1–T3 (critical/transition/comparison)", () => {
    const { queryByTestId, rerender } = render(
      <CommentaryToast toast={{ ...BASE, tier: 1 }} />,
    );
    let tint = queryByTestId("commentary-toast-tier-tint");
    expect(tint).not.toBeNull();
    expect(tint?.className).toContain("bg-accent-stale/15");
    expect(tint?.className).toContain("absolute");
    expect(tint?.className).toContain("inset-0");

    rerender(<CommentaryToast toast={{ ...BASE, tier: 2 }} />);
    tint = queryByTestId("commentary-toast-tier-tint");
    expect(tint?.className).toContain("bg-accent-warn/15");

    rerender(<CommentaryToast toast={{ ...BASE, tier: 3 }} />);
    tint = queryByTestId("commentary-toast-tier-tint");
    expect(tint?.className).toContain("bg-accent-info/15");
  });

  it("does NOT render the tier-tint overlay for T4 / T5 (ambient narration stays neutral)", () => {
    const { queryByTestId, rerender } = render(
      <CommentaryToast toast={{ ...BASE, tier: 4 }} />,
    );
    expect(queryByTestId("commentary-toast-tier-tint")).toBeNull();

    rerender(<CommentaryToast toast={{ ...BASE, tier: 5 }} />);
    expect(queryByTestId("commentary-toast-tier-tint")).toBeNull();
  });

  it("base background uses `bg-bg-elev/75` (translucent slate so underlying content is subtly visible)", () => {
    const { getByTestId } = render(<CommentaryToast toast={BASE} />);
    expect(getByTestId("commentary-toast").className).toContain(
      "bg-bg-elev/75",
    );
  });

  it("T5 tier dot is the hollow-ring variant (visually distinct from T4 muted-filled)", () => {
    const { getByTestId } = render(
      <CommentaryToast toast={{ ...BASE, tier: 5 }} />,
    );
    const dot = getByTestId("commentary-toast-tier-dot");
    expect(dot.className).toContain("border-fg-muted");
    expect(dot.className).toContain("bg-transparent");
  });

  it("multi-line text doesn't truncate — long content wraps within max-w-[640px]", () => {
    const long: CommentaryToastInstance = {
      ...BASE,
      id: "t-long",
      text: "This is a longer narration that fits onto multiple lines because the toast's max width is six hundred and forty pixels and the content height adapts to whatever the text needs.",
    };
    const { getByTestId } = render(<CommentaryToast toast={long} />);
    expect(getByTestId("commentary-toast-text").textContent).toContain(
      "six hundred and forty pixels",
    );
  });

  it("toast carries `backdrop-blur-md` so panel content behind stays subtly visible", () => {
    const { getByTestId } = render(<CommentaryToast toast={BASE} />);
    expect(getByTestId("commentary-toast").className).toContain(
      "backdrop-blur-md",
    );
  });
});
