import { apiSettings } from '@/api/settings';
import { JAILBREAK_PROMPT } from './prompts';

/** 所有副任务共用,禁用与自定义空串均不得回退默认。 */
export function taskContextPrompt(): string {
  if (apiSettings.taskContextMode === 'disabled') return '';
  if (apiSettings.taskContextMode === 'custom') return apiSettings.prompts.jailbreak.trim();
  return JAILBREAK_PROMPT;
}
