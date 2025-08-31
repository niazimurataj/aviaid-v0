import {
  customProvider,
  // extractReasoningMiddleware,
  // wrapLanguageModel,
} from 'ai';

import { fireworks } from '@ai-sdk/fireworks';

import {
  artifactModel,
  chatModel,
  // reasoningModel,
  titleModel,
} from './models.test';
import { isTestEnvironment } from '../constants';

export const myProvider = isTestEnvironment
  ? customProvider({
      languageModels: {
        'chat-model': chatModel,
        // 'chat-model-reasoning': reasoningModel,
        'title-model': titleModel,
        'artifact-model': artifactModel,
      },
    })
  : customProvider({
      languageModels: {
        'chat-model': fireworks('accounts/fireworks/models/gpt-oss-120b'),
        // 'chat-model-reasoning': wrapLanguageModel({
        //   model: fireworks('accounts/fireworks/models/gpt-oss-120b'),
        //   middleware: extractReasoningMiddleware({ tagName: 'think' }),
        // }),
        'title-model': fireworks('accounts/fireworks/models/gpt-oss-120b'),
        'artifact-model': fireworks('accounts/fireworks/models/gpt-oss-120b'),
      },
      imageModels: {
        'small-model': fireworks.image(
          'accounts/fireworks/models/flux-1-dev-fp8',
        ),
      },
    });
