// @vitest-environment happy-dom

// Tests for the commentary on/off toggle button living in the demo's
// toolbar. The button is optional: it renders only when both
// `onCommentaryToggleClick` and `commentaryEnabled` are supplied.
// Recording mode omits both so the toggle is hidden.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Controls, type ControlsProps } from "../../src/components/Controls.js";

const BASE_PROPS: ControlsProps = {
  tickRateHz: 50,
  setTickRateHz: () => {},
  nExpiriesFitted: 70,
  setNExpiriesFitted: () => {},
  displayMaturityYears: 1,
  setDisplayMaturityYears: () => {},
  repairMode: "on",
  setRepairMode: () => {},
  onShock: () => {},
  shocking: false,
};

describe("Controls — commentary toggle", () => {
  it("renders the toggle when both props are supplied", () => {
    const { queryByTestId } = render(
      <Controls
        {...BASE_PROPS}
        onCommentaryToggleClick={() => {}}
        commentaryEnabled={true}
      />,
    );
    expect(queryByTestId("toolbar-commentary-toggle")).toBeInstanceOf(
      HTMLButtonElement,
    );
  });

  it("omits the toggle when neither prop is supplied (recording-mode case)", () => {
    const { queryByTestId } = render(<Controls {...BASE_PROPS} />);
    expect(queryByTestId("toolbar-commentary-toggle")).toBeNull();
  });

  it("omits the toggle when only the click handler is supplied (defensive: both required)", () => {
    const { queryByTestId } = render(
      <Controls {...BASE_PROPS} onCommentaryToggleClick={() => {}} />,
    );
    expect(queryByTestId("toolbar-commentary-toggle")).toBeNull();
  });

  it("clicking the toggle invokes the callback", () => {
    const onClick = vi.fn();
    const { getByTestId } = render(
      <Controls
        {...BASE_PROPS}
        onCommentaryToggleClick={onClick}
        commentaryEnabled={true}
      />,
    );
    (getByTestId("toolbar-commentary-toggle") as HTMLButtonElement).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("aria-pressed reflects commentaryEnabled=true", () => {
    const { getByTestId } = render(
      <Controls
        {...BASE_PROPS}
        onCommentaryToggleClick={() => {}}
        commentaryEnabled={true}
      />,
    );
    expect(
      getByTestId("toolbar-commentary-toggle").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("aria-pressed reflects commentaryEnabled=false", () => {
    const { getByTestId } = render(
      <Controls
        {...BASE_PROPS}
        onCommentaryToggleClick={() => {}}
        commentaryEnabled={false}
      />,
    );
    expect(
      getByTestId("toolbar-commentary-toggle").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("aria-label tracks the next action — 'pause commentary' when enabled", () => {
    const { getByTestId } = render(
      <Controls
        {...BASE_PROPS}
        onCommentaryToggleClick={() => {}}
        commentaryEnabled={true}
      />,
    );
    const button = getByTestId("toolbar-commentary-toggle");
    expect(button.getAttribute("aria-label")).toBe("pause commentary");
    expect(button.getAttribute("title")).toBe("pause commentary");
  });

  it("aria-label tracks the next action — 'play commentary' when disabled", () => {
    const { getByTestId } = render(
      <Controls
        {...BASE_PROPS}
        onCommentaryToggleClick={() => {}}
        commentaryEnabled={false}
      />,
    );
    const button = getByTestId("toolbar-commentary-toggle");
    expect(button.getAttribute("aria-label")).toBe("play commentary");
    expect(button.getAttribute("title")).toBe("play commentary");
  });

  it("is focusable via Tab + activates via Enter and Space", () => {
    const onClick = vi.fn();
    const { getByTestId } = render(
      <Controls
        {...BASE_PROPS}
        onCommentaryToggleClick={onClick}
        commentaryEnabled={true}
      />,
    );
    const button = getByTestId(
      "toolbar-commentary-toggle",
    ) as HTMLButtonElement;
    // Buttons receive keyboard focus by default; verify it can hold it.
    button.focus();
    expect(document.activeElement).toBe(button);
    // Enter on a focused <button type="button"> fires click in the
    // browser; happy-dom dispatches click for the same key events.
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
