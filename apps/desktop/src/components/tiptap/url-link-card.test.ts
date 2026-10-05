// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUrlLinkCard, openModifierLabel, type UrlLinkCard, type UrlLinkCardAction } from "./url-link-card";

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";

function linkFor(url: string): HTMLElement {
  const link = document.createElement("span");
  link.className = "url-detected";
  link.dataset.url = url;
  link.textContent = url;
  document.body.append(link);
  return link;
}

function cardElement(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".url-link-card");
}

function actionsShown(): string[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(".url-link-card-action")).map((button) => button.dataset.action ?? "");
}

describe("url link card", () => {
  let card: UrlLinkCard;
  let onAction: ReturnType<typeof vi.fn<(action: UrlLinkCardAction, url: string) => void>>;
  let sigmaAvailable: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    sigmaAvailable = true;
    onAction = vi.fn();
    card = createUrlLinkCard({ onAction, canOpenInSigma: () => sigmaAvailable });
  });

  afterEach(() => {
    card.destroy();
    vi.useRealTimers();
  });

  it("waits a moment before showing, so passing over a link shows nothing", () => {
    card.hoverLink(linkFor(URL_A), { x: 10, y: 10 });
    expect(cardElement()).toBeNull();

    card.leaveLink();
    vi.advanceTimersByTime(1000);
    expect(cardElement()).toBeNull();
  });

  it("offers QR code, the default browser and Sigma for the hovered URL", () => {
    card.hoverLink(linkFor(URL_A), { x: 10, y: 10 });
    vi.advanceTimersByTime(300);

    expect(cardElement()?.dataset.url).toBe(URL_A);
    expect(actionsShown()).toEqual(["qr", "browser", "sigma"]);
    expect(card.isOpen()).toBe(true);
  });

  it("leaves out Sigma where there is no in-app browser", () => {
    sigmaAvailable = false;
    card.hoverLink(linkFor(URL_A), { x: 10, y: 10 });
    vi.advanceTimersByTime(300);

    expect(actionsShown()).toEqual(["qr", "browser"]);
  });

  it("runs the chosen action with the URL and closes", () => {
    card.hoverLink(linkFor(URL_A), { x: 10, y: 10 });
    vi.advanceTimersByTime(300);

    document.body.querySelector<HTMLElement>('[data-action="browser"]')?.click();

    expect(onAction).toHaveBeenCalledExactlyOnceWith("browser", URL_A);
    expect(cardElement()).toBeNull();
  });

  it("does not move the editor selection when a button is pressed", () => {
    card.hoverLink(linkFor(URL_A), { x: 10, y: 10 });
    vi.advanceTimersByTime(300);

    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    document.body.querySelector<HTMLElement>('[data-action="qr"]')?.dispatchEvent(press);

    expect(press.defaultPrevented).toBe(true);
  });

  it("stays while the pointer travels from the link to the card, and closes after leaving both", () => {
    card.hoverLink(linkFor(URL_A), { x: 10, y: 10 });
    vi.advanceTimersByTime(300);

    card.leaveLink();
    cardElement()?.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(1000);
    expect(cardElement()).not.toBeNull();

    cardElement()?.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(300);
    expect(cardElement()).toBeNull();
  });

  it("keeps the card for another line of the same URL, but swaps it for a different URL", () => {
    const first = linkFor(URL_A);
    card.hoverLink(first, { x: 10, y: 10 });
    vi.advanceTimersByTime(300);
    const shown = cardElement();

    card.hoverLink(linkFor(URL_A), { x: 10, y: 40 });
    expect(cardElement()).toBe(shown);

    card.hoverLink(linkFor(URL_B), { x: 10, y: 80 });
    // 古い URL のカードは残さない (押すと別の URL を開いてしまう)。
    expect(cardElement()).toBeNull();
    vi.advanceTimersByTime(300);
    expect(cardElement()?.dataset.url).toBe(URL_B);
  });

  it("closes on Escape and on scroll", () => {
    card.hoverLink(linkFor(URL_A), { x: 10, y: 10 });
    vi.advanceTimersByTime(300);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(cardElement()).toBeNull();

    card.hoverLink(linkFor(URL_A), { x: 10, y: 10 });
    vi.advanceTimersByTime(300);
    window.dispatchEvent(new Event("scroll"));
    expect(cardElement()).toBeNull();
  });

  it("does not show for a link that left the document while waiting", () => {
    const link = linkFor(URL_A);
    card.hoverLink(link, { x: 10, y: 10 });
    link.remove();
    vi.advanceTimersByTime(300);

    expect(cardElement()).toBeNull();
  });

  it("removes its card when destroyed", () => {
    card.hoverLink(linkFor(URL_A), { x: 10, y: 10 });
    vi.advanceTimersByTime(300);

    card.destroy();

    expect(cardElement()).toBeNull();
  });
});

describe("open modifier label", () => {
  it("names Command on macOS and Ctrl elsewhere", () => {
    expect(openModifierLabel("MacIntel")).toBe("⌘");
    expect(openModifierLabel("Win32")).toBe("Ctrl");
    expect(openModifierLabel("Linux x86_64")).toBe("Ctrl");
  });
});
