import { isMessagePostedEvent, type TimelineEventView } from '$lib/render/timelineEvents';


/** Return whether a deleted message has no visible context worth retaining. */
export function shouldHideTombstone(event: TimelineEventView): boolean {
  const message = event.event;
  if (!isMessagePostedEvent(message) || !message.deletedAt || message.body != null) return false;
  if ((message.attachments?.length ?? 0) > 0 || message.linkPreview) return false;
  return (message.reactions?.length ?? 0) === 0 && message.replyCount === 0;
}

export function visibleTombstoneEvents(events: TimelineEventView[]): TimelineEventView[] {
  return events.filter((event) => !shouldHideTombstone(event));
}

export function visibleUnreadMarkerEventId(
  timelineEvents: TimelineEventView[],
  visibleEvents: TimelineEventView[],
  unreadEventId: string | null
): string | null {
  if (!unreadEventId) return null;
  if (visibleEvents.some((event) => event.id === unreadEventId)) return unreadEventId;

  const markerIndex = timelineEvents.findIndex((event) => event.id === unreadEventId);
  if (markerIndex === -1) return null;
  const visibleIDs = new Set(visibleEvents.map((event) => event.id));
  for (let i = markerIndex + 1; i < timelineEvents.length; i++) {
    if (visibleIDs.has(timelineEvents[i].id)) return timelineEvents[i].id;
  }
  return null;
}
