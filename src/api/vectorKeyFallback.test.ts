import { afterEach, describe, expect, it } from 'vitest';
import { apiSettings, resolveVectorModel } from './settings';

const saved = JSON.stringify(apiSettings.vector);
afterEach(() => { Object.assign(apiSettings.vector, JSON.parse(saved)); });

// Rerank/Query 重写的密钥留空时复用 Embedding 的密钥,只限同一服务器,免得把密钥发到别家地址。
describe('向量端点的密钥回落', () => {
  it('地址也留空、或与 Embedding 同一服务器时复用 Embedding 的密钥', () => {
    Object.assign(apiSettings.vector.embedding, { url: 'https://api.siliconflow.cn/v1', key: 'sk-embed' });
    Object.assign(apiSettings.vector.rerank, { url: '', key: '' });
    Object.assign(apiSettings.vector.queryRewrite, { url: 'https://api.siliconflow.cn/v1/', key: '' });
    expect(resolveVectorModel('rerank')).toMatchObject({ url: 'https://api.siliconflow.cn/v1', key: 'sk-embed' });
    expect(resolveVectorModel('queryRewrite').key).toBe('sk-embed');
  });

  it('另填了其他服务器的地址却没填密钥时不带 Embedding 的密钥；自己填了密钥照常使用', () => {
    Object.assign(apiSettings.vector.embedding, { url: 'https://api.siliconflow.cn/v1', key: 'sk-embed' });
    Object.assign(apiSettings.vector.rerank, { url: 'https://rerank.example.com/v1', key: '' });
    Object.assign(apiSettings.vector.queryRewrite, { url: 'https://chat.example.com/v1', key: 'sk-own' });
    expect(resolveVectorModel('rerank').key).toBe('');
    expect(resolveVectorModel('queryRewrite').key).toBe('sk-own');
  });
});
