import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
} from 'ai';
import type { TextStreamPart, StreamTextTransform } from 'ai';
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

export const maxDuration = 60;

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

// Put near the top of the file
function stripCoTTransform(): TransformStream<any, any> {
  let inThink = false; // are we inside a <think>… block?
  let carry = ''; // holds partial text when tags split across chunks

  return new TransformStream({
    transform(part: any, controller: TransformStreamDefaultController<any>) {
      // A) Drop dedicated "reasoning" frames entirely
      if (part?.type === 'reasoning') return;

      // B) Clean incremental text chunks
      if (part?.type === 'text-delta') {
        let chunk = String(part.textDelta ?? '');
        if (!chunk) return;

        // join with any tail from the previous chunk
        chunk = carry + chunk;
        carry = '';

        let out = '';
        let i = 0;

        while (i < chunk.length) {
          if (!inThink) {
            const open = chunk.indexOf('<think>', i);
            if (open === -1) {
              out += chunk.slice(i);
              break;
            }
            out += chunk.slice(i, open);
            inThink = true;
            i = open + '<think>'.length;
          } else {
            const close = chunk.indexOf('</think>', i);
            if (close === -1) {
              // closing tag not found in this chunk; keep the rest until we see it
              carry = chunk.slice(i);
              i = chunk.length;
            } else {
              // consume the think block and continue
              inThink = false;
              i = close + '</think>'.length;
            }
          }
        }

        if (out) controller.enqueue({ ...part, textDelta: out });
        return;
      }

      // C) Some providers use message-delta with a full string payload — clean it too
      if (
        part?.type === 'message-delta' &&
        typeof part?.delta?.content === 'string'
      ) {
        const cleaned = part.delta.content.replace(
          /<think>[\s\S]*?<\/think>/gi,
          '',
        );
        controller.enqueue({
          ...part,
          delta: { ...part.delta, content: cleaned },
        });
        return;
      }

      // D) Fallback in case your provider ever emits plain 'text'
      if (part?.type === 'text' && typeof part?.text === 'string') {
        const cleaned = part.text.replace(/<think>[\s\S]*?<\/think>/gi, '');
        if (cleaned) controller.enqueue({ ...part, text: cleaned });
        return;
      }

      controller.enqueue(part);
    },

    flush() {
      // If the stream ends while inside <think>, drop whatever was buffered
      inThink = false;
      carry = '';
    },
  });
}

const stripThinkingTransform: StreamTextTransform<any> = () =>
  new TransformStream<TextStreamPart<any>, TextStreamPart<any>>({
    transform(part, controller) {
      // 1) Ignore separate reasoning events (Anthropic/OpenAI reasoning models)
      if ((part as any).type === 'reasoning') return;

      // 2) Strip inline <think>...</think> blocks some models emit in text
      if ((part as any).type === 'text') {
        const cleaned = (part as any).text.replace(
          /<think>[\s\S]*?<\/think>/g,
          '',
        );
        if (!cleaned) return; // nothing to send after stripping
        controller.enqueue({ ...(part as any), text: cleaned });
        return;
      }

      // pass through everything else (tool calls, etc.)
      controller.enqueue(part);
    },
  });

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
          stopWhen: stepCountIs(5),
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
