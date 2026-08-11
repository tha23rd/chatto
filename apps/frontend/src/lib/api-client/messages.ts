import { authHeaders, createChattoClient, handleAuthError } from './connect.js';
import type { TimelineEventView } from '$lib/render/timelineEvents';
import { MessageService } from '@chatto/api-types/api/v1/messages_connect';
import { MessageActionService } from '@chatto/api-types/api/v1/message_actions_connect';
import { MessageActionStyle } from '@chatto/api-types/api/v1/message_actions_pb';
import { messageToTimelineEvent, timelineUsersForMessages } from './roomTimeline.js';
import { createAssetUploadAPI } from './assetUploads.js';

export type MessageAPIConfig = {
  serverId?: string;
  baseUrl: string;
  bearerToken: string | null;
  onAuthenticationRequired?: (serverId: string) => void;
};

export type CreateMessageInput = {
  roomId: string;
  body: string;
  attachmentAssetIds?: string[];
  attachments?: File[] | null;
  threadRootEventId?: string | null;
  inReplyTo?: string | null;
  alsoSendToChannel?: boolean;
  linkPreviewToken?: string | null;
  onAttachmentUploadUpdate?: (update: AttachmentUploadUpdate) => void;
  actions?: MessageActionInput[];
};

export type MessageActionInput = {
  id: string;
  label: string;
  style?: MessageActionStyle;
  disabled?: boolean;
};

export type AttachmentUploadUpdate =
  | {
      file: File;
      phase: 'uploading';
      committedBytes: number;
      totalBytes: number;
    }
  | { file: File; phase: 'uploaded' }
  | { file: File; phase: 'failed' };

export type UpdateMessageInput = {
  roomId: string;
  eventId: string;
  body?: string;
  alsoSendToChannel?: boolean;
  actions?: MessageActionInput[];
};

export type InvokeMessageActionInput = {
  roomId: string;
  messageEventId: string;
  actionId: string;
  requestId?: string;
};

export type CreateMessageResult = {
  event: TimelineEventView | null;
};

export type UpdateMessageResult = {
  updated: boolean;
  event: TimelineEventView | null;
};

export function createMessageAPI(config: MessageAPIConfig) {
  const client = createChattoClient(MessageService, config);
  const actionClient = createChattoClient(MessageActionService, config);
  const headers = () => authHeaders(config);
  return {
    async createMessage(input: CreateMessageInput): Promise<CreateMessageResult> {
      try {
        const uploadedAttachmentAssetIds = await uploadMessageAttachments(config, input);
        const response = await client.createMessage(
          {
            roomId: input.roomId,
            body: input.body,
            attachmentAssetIds: [
              ...(input.attachmentAssetIds ?? []),
              ...uploadedAttachmentAssetIds
            ],
            threadRootEventId: input.threadRootEventId ?? '',
            inReplyTo: input.inReplyTo ?? '',
            alsoSendToChannel: input.alsoSendToChannel ?? false,
            linkPreviewToken: input.linkPreviewToken ?? '',
            actions:
              input.actions === undefined
                ? undefined
                : {
                    actions: input.actions.map((action) => ({
                      ...action,
                      style: action.style ?? MessageActionStyle.UNSPECIFIED,
                      disabled: action.disabled ?? false
                    }))
                  }
          },
          { headers: headers() }
        );

        const users = await timelineUsersForMessages(config, response.message ? [response.message] : []);
        return {
          event: response.message
            ? messageToTimelineEvent(response.message, users)
            : null
        };
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async updateMessage(input: UpdateMessageInput): Promise<UpdateMessageResult> {
      try {
        const request: {
          roomId: string;
          eventId: string;
          body?: string;
          alsoSendToChannel?: boolean;
          actions?: { actions: MessageActionInput[] };
        } = {
          roomId: input.roomId,
          eventId: input.eventId
        };
        if (input.body !== undefined) {
          request.body = input.body;
        }
        if (input.alsoSendToChannel !== undefined) {
          request.alsoSendToChannel = input.alsoSendToChannel;
        }
        if (input.actions !== undefined) {
          request.actions = { actions: input.actions };
        }
        const response = await client.updateMessage(request, {
          headers: headers()
        });
        const users = await timelineUsersForMessages(config, response.message ? [response.message] : []);
        return {
          updated: true,
          event: response.message
            ? messageToTimelineEvent(response.message, users)
            : null
        };
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async deleteMessage(roomId: string, eventId: string): Promise<boolean> {
      try {
        const response = await client.deleteMessage({ roomId, eventId }, { headers: headers() });
        return response.deleted;
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async deleteAttachment(
      roomId: string,
      eventId: string,
      attachmentId: string
    ): Promise<boolean> {
      try {
        const response = await client.deleteAttachment(
          { roomId, eventId, attachmentId },
          { headers: headers() }
        );
        return response.deleted;
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async deleteLinkPreview(roomId: string, eventId: string, url: string): Promise<boolean> {
      try {
        const response = await client.deleteLinkPreview(
          { roomId, eventId, url },
          { headers: headers() }
        );
        return response.deleted;
      } catch (err) {
        return handleAuthError(config, err);
      }
    },

    async invokeMessageAction(input: InvokeMessageActionInput): Promise<void> {
      try {
        await actionClient.invokeMessageAction(
          {
            roomId: input.roomId,
            messageEventId: input.messageEventId,
            actionId: input.actionId,
            requestId: input.requestId ?? crypto.randomUUID()
          },
          { headers: headers() }
        );
      } catch (err) {
        return handleAuthError(config, err);
      }
    }
  };
}

async function uploadMessageAttachments(config: MessageAPIConfig, input: CreateMessageInput) {
  const files = input.attachments;
  if (!files?.length) return [];
  const uploads = createAssetUploadAPI(config);
  const results = await Promise.allSettled(
    files.map(async (file) => {
      try {
        const asset = await uploads.uploadAttachment({
          roomId: input.roomId,
          file,
          onProgress: (committedBytes, totalBytes) => {
            input.onAttachmentUploadUpdate?.({
              file,
              phase: 'uploading',
              committedBytes,
              totalBytes
            });
          }
        });
        input.onAttachmentUploadUpdate?.({ file, phase: 'uploaded' });
        return asset;
      } catch (error) {
        input.onAttachmentUploadUpdate?.({ file, phase: 'failed' });
        throw error;
      }
    })
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value.assetId;
  });
}
