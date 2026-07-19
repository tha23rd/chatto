import { describe, expect, it } from "vitest";
import { validNotificationRequest, validTrayState } from "./shellFeatures.js";

const labels = {
  open: "Open",
  mute: "Mute",
  unmute: "Unmute",
  deafen: "Deafen",
  undeafen: "Undeafen",
  quit: "Quit",
};

describe("shell feature payload validation", () => {
  it("accepts complete, bounded tray state", () => {
    expect(
      validTrayState({
        callActive: true,
        muted: false,
        deafened: true,
        unreadCount: 4,
        labels,
      }),
    ).toBe(true);
    expect(
      validTrayState({
        callActive: false,
        muted: false,
        deafened: false,
        unreadCount: -1,
        labels,
      }),
    ).toBe(false);
    expect(
      validTrayState({
        callActive: false,
        muted: false,
        deafened: false,
        unreadCount: 0,
        labels: {},
      }),
    ).toBe(false);
  });

  it("accepts notification payloads without trusting loose objects", () => {
    expect(
      validNotificationRequest({
        id: "notification-1",
        title: "New mention",
        body: "A message arrived",
        canReply: true,
        replyPlaceholder: "Reply",
      }),
    ).toBe(true);
    expect(
      validNotificationRequest({
        id: "",
        title: "New mention",
        body: "A message arrived",
        canReply: true,
        replyPlaceholder: "Reply",
      }),
    ).toBe(false);
  });
});
