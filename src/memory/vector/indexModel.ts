/**
 * 记录每个聊天的向量索引是用哪个 Embedding 模型建立的(A56)。
 *
 * 换了 Embedding 模型后旧向量与新查询不可比:维度不同时相似度无法计算,维度相同时分数也没有意义。
 * 索引的对账只比较摘要文本,察觉不到换模型,所以这里按「向量库 + scope」记下建索引时的模型和维度:
 *  - 第一次写入向量时记录;之后换了模型再补写的向量不覆盖记录,提示会一直保留,直到清空重建;
 *  - 升级前已有的索引没有记录,视为当前模型(对账发现已有向量时补记当前模型);
 *  - 召回时比较当前模型名和查询向量的维度,设置页比较模型名,不一致时提示「清空并重建」。
 * 记录存在本机 localStorage,不随聊天同步;取不到时按没有记录处理,不影响索引和召回。
 */

const STORAGE_KEY = 'bbs_vec_index_models';
/** 最多保留的记录条数(按最近写入排序),避免本机存储无限增长。 */
const MAX_RECORDS = 300;

export interface IndexModelRecord {
  /** 建立索引时的 Embedding 模型名 */
  model: string;
  /** 向量维度;对账补记的老索引没有维度 */
  dim?: number;
  /** 最近一次写入记录的时间 */
  at: number;
}

type RecordMap = Record<string, IndexModelRecord>;

function keyOf(database: string, scope: string): string {
  return `${database}|${scope}`;
}

function load(): RecordMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RecordMap) : {};
  } catch {
    return {};
  }
}

function save(map: RecordMap): void {
  try {
    const entries = Object.entries(map).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, MAX_RECORDS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 隐私模式或存储已满:放弃记录,不影响索引 */
  }
}

/** 读取某个 scope 的模型记录;没有或格式不对时返回 null。 */
export function readIndexModel(database: string, scope: string): IndexModelRecord | null {
  const rec = load()[keyOf(database, scope)];
  if (!rec || typeof rec.model !== 'string' || !rec.model) return null;
  return { model: rec.model, at: typeof rec.at === 'number' ? rec.at : 0, ...(typeof rec.dim === 'number' && rec.dim > 0 ? { dim: rec.dim } : {}) };
}

/**
 * 写入向量后调用:没有记录时记下当前模型和维度;同一模型的记录补上维度;
 * 记录的模型与当前不同时保持原记录(索引里混有两种向量,需要清空重建)。
 */
export function noteIndexModel(database: string, scope: string, model: string, dim?: number): void {
  const name = model.trim();
  if (!database || !scope || !name) return;
  const map = load();
  const key = keyOf(database, scope);
  const cur = map[key];
  const validDim = typeof dim === 'number' && dim > 0 ? dim : undefined;
  if (cur && typeof cur.model === 'string' && cur.model) {
    if (cur.model !== name || cur.dim || !validDim) return;
    map[key] = { ...cur, dim: validDim, at: Date.now() };
  } else {
    map[key] = { model: name, ...(validDim ? { dim: validDim } : {}), at: Date.now() };
  }
  save(map);
}

/** 清空某个 scope 的索引后调用:删掉记录,重建时按新模型重新记录。 */
export function forgetIndexModel(database: string, scope: string): void {
  const map = load();
  const key = keyOf(database, scope);
  if (!(key in map)) return;
  delete map[key];
  save(map);
}

/** 重建入口统一用这个位置提示用户。 */
const REBUILD_HINT = '请到「设置 → 向量记忆 → 索引维护」点「清空并重建」。';

/**
 * 索引与当前 Embedding 是否不可比。queryDim 是本次查询向量的维度(召回时才有)。
 * 可比或没有记录时返回空串。
 */
export function indexModelIssue(database: string, scope: string, currentModel: string, queryDim?: number): string {
  const rec = readIndexModel(database, scope);
  if (!rec) return '';
  const model = currentModel.trim();
  if (model && rec.model !== model) {
    return `当前聊天的向量索引是用「${rec.model}」建立的，现在的 Embedding 模型是「${model}」，两者的向量不可比。${REBUILD_HINT}`;
  }
  if (rec.dim && typeof queryDim === 'number' && queryDim > 0 && rec.dim !== queryDim) {
    return `当前 Embedding 返回的向量是 ${queryDim} 维，索引里是 ${rec.dim} 维，相似度无法比较。${REBUILD_HINT}`;
  }
  return '';
}
