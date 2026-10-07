import { describe, expect, it } from 'vitest';
import { extractJsonObject } from './json';

const result = { summary: 'The confirmed facts.' };
const json = JSON.stringify(result);
const record = 'F1 | source 1 | confirmed fact\nCoverage: F1 | confirmed facts';

describe('extractJsonObject with visible audit records', () => {
  it.each([
    `${json}`,
    `<thinking>\n${record}\n</thinking>\n${json}`,
    `<think>\n${record}\n</think>\n${json}`,
    `${record}\n</thinking>\n${json}`,
    `<THINKING>\n${record}\n</THINKING>\n${json}`,
    `<thinking>\n${record}\n{"summary":"not the final result"}\n</thinking>\n${json}`,
    `${record}\n{"summary":"not the final result"}\n</thinking>\n${json}`,
  ])('only parses the final result [%#]: %s', raw => {
    expect(extractJsonObject(raw)).toEqual(result);
  });

  it('keeps batch results unchanged and does not persist the audit', () => {
    const batch = {
      floors: [{ n: 1, summary: 'The first floor.', timeStart: '2030/1/1 10:00', timeEnd: '2030/1/1 10:05' }],
    };
    expect(extractJsonObject(`<thinking>${record}</thinking>${JSON.stringify(batch)}`)).toEqual(batch);
  });

  it.each([
    `<thinking>${record}</thinking>`,
    `${record}</thinking>`,
    '<thinking>{"summary":"an unfinished audit, not a final answer"}',
    '<think>{"summary":"an unfinished audit, not a final answer"}',
    `<thinking>${record}</thinking><thinking>{"summary":"a second unfinished audit"}`,
    `<thinking>${record}</thinking>{"summary":`,
  ])('does not accept audit-only or truncated output: %s', raw => {
    expect(extractJsonObject(raw)).toBeNull();
  });
});
