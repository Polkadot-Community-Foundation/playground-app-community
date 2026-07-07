// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import { useIntersectionObserver, useRotatingMessage } from "./hooks";

// Test harness — a component that wires the hook's returned ref to a div.
// Tests trigger intersection via the IntersectionObserver mock and assert
// on the callback / cleanup behaviour.
function Sentinel({
  onIntersect,
  enabled,
}: {
  onIntersect: () => void;
  enabled: boolean;
}) {
  const ref = useIntersectionObserver(onIntersect, enabled);
  return <div ref={ref} data-testid="sentinel" />;
}

interface MockObserverInstance {
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
}

const instances: MockObserverInstance[] = [];

class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = opts;
    instances.push(this as unknown as MockObserverInstance);
  }
}

beforeEach(() => {
  instances.length = 0;
  // happy-dom doesn't ship IntersectionObserver — globally stub for the
  // duration of each test. The constructor records itself on `instances`
  // so tests can synchronously trigger the callback.
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useIntersectionObserver", () => {
  it("observes the element while enabled", () => {
    const onIntersect = vi.fn();
    render(<Sentinel onIntersect={onIntersect} enabled />);

    expect(instances).toHaveLength(1);
    expect(instances[0].observe).toHaveBeenCalledTimes(1);
  });

  it("does not observe when enabled=false", () => {
    // If enabled is false the hook bails out before constructing the
    // observer. Catches the regression where the guard is dropped and the
    // hook starts observing even when the parent says "off".
    const onIntersect = vi.fn();
    render(<Sentinel onIntersect={onIntersect} enabled={false} />);

    expect(instances).toHaveLength(0);
  });

  it("invokes the callback when the sentinel intersects", () => {
    const onIntersect = vi.fn();
    render(<Sentinel onIntersect={onIntersect} enabled />);

    // Simulate a viewport intersection by driving the mocked observer's
    // callback. Real IntersectionObserver only fires `isIntersecting=true`
    // on the way in — the hook's `if (entry.isIntersecting) ...` guard
    // means a `false` entry must NOT trigger the callback.
    const instance = instances[0];
    instance.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      instance as unknown as IntersectionObserver,
    );
    expect(onIntersect).toHaveBeenCalledTimes(1);

    instance.callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      instance as unknown as IntersectionObserver,
    );
    expect(onIntersect).toHaveBeenCalledTimes(1);
  });

  it("disconnects on unmount (cleanup leak guard)", () => {
    // The hook's cleanup must call observer.disconnect() — otherwise long-
    // lived pages accumulate observers across remounts. Mounts get cheap
    // and frequent in React 19 + StrictMode; this guard would catch a
    // regression where the cleanup was dropped.
    const onIntersect = vi.fn();
    const { unmount } = render(<Sentinel onIntersect={onIntersect} enabled />);

    const instance = instances[0];
    expect(instance.disconnect).not.toHaveBeenCalled();

    unmount();
    expect(instance.disconnect).toHaveBeenCalledTimes(1);
  });

  it("passes the documented rootMargin/threshold to the observer", () => {
    // The hook bakes in 400px rootMargin + 0.1 threshold — these are
    // tuned for the infinite-scroll behaviour (start loading the next page
    // ~400px before the sentinel hits the viewport). Asserting the values
    // catches an inadvertent change to either, which would affect the
    // pagination UX.
    const onIntersect = vi.fn();
    render(<Sentinel onIntersect={onIntersect} enabled />);

    expect(instances[0].options).toEqual({ threshold: 0.1, rootMargin: "400px" });
  });
});

describe("useRotatingMessage", () => {
  function Rotator({ messages, interval }: { messages: readonly string[]; interval?: number }) {
    const { text } = useRotatingMessage(messages, interval);
    return <span data-testid="msg">{text}</span>;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts on the first message", () => {
    render(<Rotator messages={["a", "b", "c"]} interval={1000} />);
    expect(screen.getByTestId("msg").textContent).toBe("a");
  });

  it("advances on the interval and wraps to the start", () => {
    render(<Rotator messages={["a", "b", "c"]} interval={1000} />);
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("msg").textContent).toBe("b");
    act(() => void vi.advanceTimersByTime(2000));
    // a → b → c → a: 3 ticks lands back on the first message.
    expect(screen.getByTestId("msg").textContent).toBe("a");
  });

  it("never schedules a timer for a single-message list", () => {
    render(<Rotator messages={["only"]} interval={1000} />);
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByTestId("msg").textContent).toBe("only");
  });
});
