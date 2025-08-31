'use server';

import { generateText, type UIMessage } from 'ai';
import { cookies } from 'next/headers';
import {
  deleteMessagesByChatIdAfterTimestamp,
  getMessageById,
  updateChatVisiblityById,
} from '@/lib/db/queries';
import type { VisibilityType } from '@/components/visibility-selector';
import { myProvider } from '@/lib/ai/providers';

export async function saveChatModelAsCookie(model: string) {
  const cookieStore = await cookies();
  cookieStore.set('chat-model', model);
}

export async function generateTitleFromUserMessage({
  message,
}: {
  message: UIMessage;
}) {
  const { text: title } = await generateText({
    model: myProvider.languageModel('title-model'),
    system: `\n
    You are an expert at creating chat titles for aircraft maintenance conversations.
             Your task is to create a title from the user's first message.
             The title MUST follow this exact format: <Helicopter Name> <Issue>
             - First, identify the specific helicopter model from the user's message (e.g., "AH-64 Apache", "UH-60 Black Hawk", "CH-47 Chinook").
             - Second, identify the primary maintenance issue or question.
             - Combine them into a single title.
             - If you cannot identify a specific helicopter or issue, create a concise summary of the user's message.
             - The final title must not exceed 80 characters.
            - Do not use quotes or colons.
   
            Example user message: "My AH-64 is having trouble with the TADS system, it's not tracking properly."
            Example title: "AH-64 Apache TADS Tracking"
    `,
    prompt: JSON.stringify(message),
  });

  return title;
}

export async function deleteTrailingMessages({ id }: { id: string }) {
  const [message] = await getMessageById({ id });

  await deleteMessagesByChatIdAfterTimestamp({
    chatId: message.chatId,
    timestamp: message.createdAt,
  });
}

export async function updateChatVisibility({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: VisibilityType;
}) {
  await updateChatVisiblityById({ chatId, visibility });
}
