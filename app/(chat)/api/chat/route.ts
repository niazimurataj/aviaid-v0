import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  // smoothStream,
  // stepCountIs,
  streamText,
} from 'ai';
// import type { TextStreamPart, StreamTextTransform } from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import type { ChatMessage } from '@/lib/types';
import type { ChatModel } from '@/lib/ai/models';
import type { VisibilityType } from '@/components/visibility-selector';

export const maxDuration = 120;

let globalStreamContext: ResumableStreamContext | null = null;

export function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(
          ' > Resumable streams are disabled due to missing REDIS_URL',
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}

const stripCoTTransform: () => TransformStream<any, any> = () => {
  let buffer = '';
  let inThink = false;

  const OPEN_RE = /<think\b[^>]*>/i;
  const CLOSE_RE = /<\/think\s*>/i;

  return new TransformStream<any, any>({
    transform(part, controller) {
      if (part?.type === 'reasoning') return;

      // --- TEXT STREAMING ---
      if (part?.type === 'text-delta') {
        buffer += String(part.textDelta ?? '');

        let out = '';

        for (;;) {
          // 1) If we're not inside a think block, drop any *orphan* closers up front.
          if (!inThink) {
            const closeFirst = buffer.match(CLOSE_RE);
            const openFirst = buffer.match(OPEN_RE);
            if (
              closeFirst &&
              typeof closeFirst.index === 'number' &&
              (!openFirst ||
                (typeof openFirst.index === 'number' &&
                  closeFirst.index < openFirst.index))
            ) {
              // remove the orphan closer and keep scanning
              buffer =
                buffer.slice(0, closeFirst.index) +
                buffer.slice(closeFirst.index + closeFirst[0].length);
              continue;
            }
          }

          if (!inThink) {
            const mOpen = buffer.match(OPEN_RE);
            if (!mOpen) {
              // No open tag → emit almost everything, keep a small tail in case "<think" splits across chunks
              const KEEP_TAIL = 16;
              if (buffer.length > KEEP_TAIL) {
                out += buffer.slice(0, buffer.length - KEEP_TAIL);
                buffer = buffer.slice(buffer.length - KEEP_TAIL);
              }
              break;
            }
            // Emit text before <think>
            const openIndex = mOpen.index ?? 0;
            out += buffer.slice(0, openIndex);
            // Drop the open tag and enter think mode
            buffer = buffer.slice(openIndex + mOpen[0].length);
            inThink = true;
            continue;
          }

          // inThink === true: look for the close
          const mClose = buffer.match(CLOSE_RE);
          if (!mClose) {
            // Still inside; keep buffer bounded so memory doesn't grow
            if (buffer.length > 8192) buffer = buffer.slice(-4096);
            break;
          }
          // Drop everything up to and including the close tag
          const closeIndex = mClose.index ?? 0;
          buffer = buffer.slice(closeIndex + mClose[0].length);
          inThink = false;
          // Loop to find more
        }

        if (out) controller.enqueue({ ...part, textDelta: out });
        return;
      }

      // --- MESSAGE-DELTA FALLBACK ---
      if (
        part?.type === 'message-delta' &&
        typeof part?.delta?.content === 'string'
      ) {
        const cleaned = part.delta.content
          // remove complete blocks
          .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '')
          // remove any orphan closers or openers that slipped in
          .replace(/<\/think\s*>/gi, '')
          .replace(/<think\b[^>]*>/gi, '');
        controller.enqueue({
          ...part,
          delta: { ...part.delta, content: cleaned },
        });
        return;
      }

      // --- RARE: PLAIN TEXT ---
      if (part?.type === 'text' && typeof part?.text === 'string') {
        const cleaned = part.text
          .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '')
          .replace(/<\/think\s*>/gi, '')
          .replace(/<think\b[^>]*>/gi, '');
        if (cleaned) controller.enqueue({ ...part, text: cleaned });
        return;
      }

      controller.enqueue(part);
    },

    flush(controller) {
      // If we end *not* inside think, emit whatever safe text remains (after killing orphan closers).
      if (!inThink && buffer) {
        const safe = buffer.replace(/<\/think\s*>/gi, '');
        if (safe) controller.enqueue({ type: 'text-delta', textDelta: safe });
      }
      buffer = '';
      inThink = false;
    },
  });
};

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const {
      id,
      message,
      selectedChatModel,
      selectedVisibilityType,
    }: {
      id: string;
      message: ChatMessage;
      selectedChatModel: ChatModel['id'];
      selectedVisibilityType: VisibilityType;
    } = requestBody;

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError('rate_limit:chat').toResponse();
    }

    const chat = await getChatById({ id });

    if (!chat) {
      const title = await generateTitleFromUserMessage({
        message,
      });

      await saveChat({
        id,
        userId: session.user.id,
        title,
        visibility: selectedVisibilityType,
      });
    } else {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError('forbidden:chat').toResponse();
      }
    }

    const messagesFromDb = await getMessagesByChatId({ id });
    const uiMessages = [...convertToUIMessages(messagesFromDb), message];

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: 'user',
          parts: message.parts,
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    const stream = createUIMessageStream({
      execute: ({ writer: dataStream }) => {
        const result = streamText({
          model: myProvider.languageModel(selectedChatModel),
          system: systemPrompt({ selectedChatModel, requestHints }),
          messages: convertToModelMessages(uiMessages),
          // stopWhen: stepCountIs(15),
          maxOutputTokens: 4096,
          // note - you've turned off tool use!
          toolChoice: 'none',
          experimental_activeTools:
            selectedChatModel === 'chat-model'
              ? []
              : [
                  'getWeather',
                  'createDocument',
                  'updateDocument',
                  'requestSuggestions',
                ],
          experimental_transform: stripCoTTransform,
          tools: {
            getWeather,
            createDocument: createDocument({ session, dataStream }),
            updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({
              session,
              dataStream,
            }),
          },
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: 'stream-text',
          },
        });

        dataStream.merge(
          result.toUIMessageStream({
            sendReasoning: false,
          }),
        );
      },
      generateId: generateUUID,
      onFinish: async ({ messages }) => {
        await saveMessages({
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            parts: message.parts,
            createdAt: new Date(),
            attachments: [],
            chatId: id,
          })),
        });
      },
      onError: () => {
        return 'Oops, an error occurred!';
      },
    });

    const streamContext = getStreamContext();

    if (streamContext) {
      return new Response(
        await streamContext.resumableStream(streamId, () =>
          stream.pipeThrough(new JsonToSseTransformStream()),
        ),
      );
    } else {
      return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
    }
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const chat = await getChatById({ id });

  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
