/**
 * 楼层面板的就地编辑状态(从 FloorPanel.vue 拆出,行为不变)。
 *
 * 同一时刻只有一个单元在编辑(editKey):'text' | 'time' | 'loc' | 变动标签的 key(如 'item:add:0')。
 * 写走 apply.ts 的 editLeafFull(整体重放);改某条变动时由 commitDelta 克隆-改-回写。
 * FloorPanel 创建一份并 provide,DeltaGroups / DeltaTagEditor 用 inject 取用(每楼是独立的 Vue 应用,互不串)。
 */
import { computed, nextTick, reactive, ref, watch, type ComputedRef, type InjectionKey } from 'vue';
import { NPC_AFFINITY_FIELDS, affinityLevelFromInput } from '@/memory/npcRelations';
import { editLeafFull } from '@/memory/apply';
import type { DeltaTag } from '@/memory/deltaTags';
import type { JsonValue, LeafExtra, StoredDelta, VarOp } from '@/memory/types';

// 角色可编辑的文本字段注册表:统一驱动「展示副文本 / 编辑载入 / 保存 / 按需渲染输入框」,
// 一处定义,避免多处重复且保证一致。key=NpcDelta 字段名,draft=edit 草稿字段名,label=展示/占位。
export const NPC_FIELDS = [
  { key: 'title', draft: 'title', label: '身份' },
  { key: 'age', draft: 'npcAge', label: '年龄' },
  { key: 'relation', draft: 'relation', label: '关系' },
  { key: 'affinityNote', draft: 'affinityNote', label: '好感说明' },
  { key: 'outfit', draft: 'outfit', label: '着装' },
  { key: 'condition', draft: 'condition', label: '状态' },
  { key: 'desc', draft: 'npcDesc', label: '外貌' },
  { key: 'personality', draft: 'personality', label: '性格' },
  { key: 'ties', draft: 'ties', label: '人际' },
  { key: 'location', draft: 'npcLoc', label: '位置' },
] as const;

// 值 ↔ 输入框互转:字符串原样;数字/布尔/对象转 JSON 文本。解析反之:先试 JSON,失败当纯字符串。
// 故 "敌对"→字符串、"60"→数字、"true"→布尔、'{"a":1}'→对象,round-trip 稳定。
export function varValueToInput(v: JsonValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
export function parseVarValue(text: string): JsonValue {
  const t = text.trim();
  if (t === '') return '';
  try { return JSON.parse(t); } catch { return text; }
}

/** 单元编辑草稿(按需填,不同单元用不同字段)。npc 字段各自独立,不拿 desc 兼作 title。 */
export interface LeafEditDraft {
  text: string; timeStart: string; timeEnd: string; location: string;
  name: string; qty: string; desc: string; content: string;
  title: string; npcAge: string; relation: string; ties: string; outfit: string; condition: string; npcDesc: string; personality: string; npcLoc: string;
  affinityInner: string; affinityOuter: string; affinityNote: string;
  varPath: string; varKey: string; varValue: string; varDelta: string;
}

export function useLeafEdit(opts: {
  floor: number;
  leaf: ComputedRef<LeafExtra | null>;
  omit: ComputedRef<boolean>;
  d: ComputedRef<StoredDelta | null>;
}) {
  const { floor, leaf, omit, d } = opts;

  // 当前正在编辑的单元;null=无
  const editKey = ref<string | null>(null);
  const edit = reactive<LeafEditDraft>({
    text: '',
    timeStart: '',
    timeEnd: '',
    location: '',
    name: '',
    qty: '',
    desc: '',
    content: '',
    title: '',
    npcAge: '',
    relation: '',
    affinityInner: '',
    affinityOuter: '',
    affinityNote: '',
    ties: '',
    outfit: '',
    condition: '',
    npcDesc: '',
    personality: '',
    npcLoc: '',
    varPath: '',
    varKey: '',
    varValue: '',
    varDelta: '',
  });

  // 叶子消失 / 番外时退出编辑
  watch([omit, leaf], () => {
    if (editKey.value && (omit.value || !leaf.value)) editKey.value = null;
  });

  // 触屏判定:移动端进入编辑不自动聚焦——自动 focus 会立刻弹出输入法,挡住界面。
  // 让用户主动点输入框才弹(与主界面摘要弹窗同款取舍)。
  const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

  // 用函数 ref(而非字符串 ref):字符串 ref 出现在 v-for 内会被 Vue 收集成**数组**,
  // focusEl.value 变数组、没有 .focus() → 报「focus is not a function」。函数 ref 只在元素
  // 挂载时被调用一次,稳稳拿到单个元素。子组件里同样写 :ref="setFocus"。
  const focusEl = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
  function setFocus(el: unknown) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) focusEl.value = el;
  }
  function beginEdit(key: string) {
    if (omit.value || !leaf.value) return;
    focusEl.value = null; // 清掉上一次编辑的(已卸载)输入框引用,避免 focus 到游离节点
    editKey.value = key;
    void nextTick(() => {
      // 编辑区内所有 textarea 都要 autosize(字段用可换行显示的 textarea,进场先贴合内容高)
      autosizeAll();
      if (!isTouch) focusEl.value?.focus();
    });
  }
  // textarea 自适应高度:进入编辑时若仍用固定行数,长内容会瞬间缩短、抽屉回弹。
  // 让编辑框贴合内容高度,与只读态视觉连续,消除跳动。
  function autosize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }
  // 对 focusEl 所在编辑卡内的全部 textarea 逐一 autosize(多字段编辑时不止一个)
  function autosizeAll() {
    const root = focusEl.value?.closest('.bbs-fp-editform, .bbs-fp-texteditor');
    root?.querySelectorAll('textarea').forEach(t => autosize(t as HTMLTextAreaElement));
    if (focusEl.value instanceof HTMLTextAreaElement) autosize(focusEl.value);
  }
  function onTextInput(e: Event) {
    autosize(e.target as HTMLTextAreaElement);
  }
  // 字段 textarea:回车不换行(拦截 Enter,保持「单行语义、多行显示」)。Shift+Enter 也拦——都是短字段。
  function onFieldKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') e.preventDefault();
  }
  function cancelEdit() {
    editKey.value = null;
  }

  /** 克隆当前 delta,交给 mutator 改,再整体重放写回。 */
  function commitDelta(mutate: (dd: StoredDelta) => void): void {
    const l = leaf.value;
    if (!l) return;
    const dd: StoredDelta = JSON.parse(JSON.stringify(l.delta ?? {}));
    mutate(dd);
    editLeafFull(floor, {
      text: l.text ?? '',
      timeStart: l.timeStart ?? '',
      timeEnd: l.timeEnd ?? '',
      delta: dd,
    });
    editKey.value = null;
  }

  /* —— 正文 —— */
  function editText() {
    edit.text = leaf.value?.text ?? '';
    beginEdit('text');
  }
  function saveText() {
    const l = leaf.value;
    if (!l) return;
    editLeafFull(floor, { text: edit.text, timeStart: l.timeStart ?? '', timeEnd: l.timeEnd ?? '', delta: l.delta ?? {} });
    editKey.value = null;
  }

  /* —— 时间 —— */
  function editTime() {
    edit.timeStart = leaf.value?.timeStart ?? '';
    edit.timeEnd = leaf.value?.timeEnd ?? '';
    beginEdit('time');
  }
  function saveTime() {
    const l = leaf.value;
    if (!l) return;
    editLeafFull(floor, { text: l.text ?? '', timeStart: edit.timeStart, timeEnd: edit.timeEnd, delta: l.delta ?? {} });
    editKey.value = null;
  }

  /* —— 地点 —— */
  function editLoc() {
    edit.location = d.value?.location ?? '';
    beginEdit('loc');
  }
  function saveLoc() {
    const loc = edit.location.trim();
    commitDelta(dd => {
      if (loc) dd.location = loc;
      else delete dd.location;
    });
  }

  // 正在编辑的变量命令(供模板按 op 类型决定显示哪些字段:值/增量/键)
  const editingVarOp = computed<VarOp | null>(() => {
    const key = editKey.value;
    if (!key || !key.startsWith('var:')) return null;
    return d.value?.varOps?.[Number(key.split(':')[2])] ?? null;
  });

  // 当前正在编辑的角色 tag,本轮实际存在的字段(供模板按需渲染)。
  // update delta 只含本轮改动的字段——若把全部字段都渲染成空框,用户会误以为「这角色没有这些数据」,
  // 故只渲染 delta 里已存在(!== undefined)的字段;新增(add)则给全字段以便补全。
  const editingNpcDelta = computed(() => {
    const key = editKey.value;
    if (!key?.startsWith('npc:')) return undefined;
    const [, bucket, idxStr] = key.split(':');
    return (bucket === 'add' ? d.value?.npcs?.add : bucket === 'update' ? d.value?.npcs?.update : undefined)?.[Number(idxStr)];
  });
  const npcEditFields = computed(() => {
    const npc = editingNpcDelta.value;
    return npc ? NPC_FIELDS.filter(f => editKey.value?.startsWith('npc:add:') || npc[f.key] !== undefined) : [];
  });
  const npcAffinityEditFields = computed(() => {
    const npc = editingNpcDelta.value;
    return npc ? NPC_AFFINITY_FIELDS.filter(f => editKey.value?.startsWith('npc:add:') || npc[f.key] !== undefined) : [];
  });

  /* —— 物品 / 角色 / 计划 / 变量 就地改字段 —— */
  function editTag(tag: DeltaTag) {
    const dd = d.value;
    if (!dd) return;
    // 清空所有草稿字段:不可编辑的标签(scene / plan 的 resolve/reopen/remove)不会填任何字段,
    // 若不清空会残留上一次编辑的值(如刚编辑过物品,再点悬念「达成」就显示旧物品名)。
    edit.name = '';
    edit.qty = '';
    edit.desc = '';
    edit.content = '';
    edit.title = '';
    edit.npcAge = '';
    edit.relation = '';
    edit.affinityInner = '';
    edit.affinityOuter = '';
    edit.affinityNote = '';
    edit.ties = '';
    edit.outfit = '';
    edit.condition = '';
    edit.npcDesc = '';
    edit.personality = '';
    edit.npcLoc = '';
    edit.varPath = '';
    edit.varKey = '';
    edit.varValue = '';
    edit.varDelta = '';
    if (tag.key.startsWith('item:')) {
      if (tag.bucket === 'remove') {
        edit.name = dd.items?.remove?.[tag.idx] ?? '';
      } else {
        const x = (tag.bucket === 'add' ? dd.items?.add : dd.items?.update)?.[tag.idx];
        edit.name = x?.name ?? '';
        edit.qty = typeof x?.qty === 'number' ? String(x.qty) : '';
        edit.desc = x?.desc ?? '';
      }
    } else if (tag.key.startsWith('npc:')) {
      if (tag.bucket === 'remove') {
        edit.name = dd.npcs?.remove?.[tag.idx] ?? '';
      } else {
        const x = (tag.bucket === 'add' ? dd.npcs?.add : dd.npcs?.update)?.[tag.idx];
        edit.name = x?.name ?? '';
        edit.title = x?.title ?? '';
        edit.npcAge = x?.age ?? '';
        edit.relation = x?.relation ?? '';
        edit.affinityInner = x?.affinityInner == null ? '' : String(x.affinityInner);
        edit.affinityOuter = x?.affinityOuter == null ? '' : String(x.affinityOuter);
        edit.affinityNote = x?.affinityNote ?? '';
        edit.ties = x?.ties ?? '';
        edit.outfit = x?.outfit ?? '';
        edit.condition = x?.condition ?? '';
        edit.npcDesc = x?.desc ?? '';
        edit.personality = x?.personality ?? '';
        edit.npcLoc = x?.location ?? '';
      }
    } else if (tag.key.startsWith('plan:add:')) {
      edit.content = dd.plans?.add?.[tag.idx]?.content ?? '';
    } else if (tag.key.startsWith('var:')) {
      const op = dd.varOps?.[tag.idx];
      if (op) {
        edit.varPath = op.path ?? '';
        edit.varKey = op.key !== undefined ? String(op.key) : '';
        edit.varValue = varValueToInput(op.value);
        edit.varDelta = typeof op.delta === 'number' ? String(op.delta) : '';
      }
    }
    beginEdit(tag.key);
  }

  function saveTag(tag: DeltaTag) {
    commitDelta(dd => {
      if (tag.key.startsWith('item:')) {
        if (tag.bucket === 'remove') {
          if (dd.items?.remove) dd.items.remove[tag.idx] = edit.name.trim();
        } else {
          const arr = tag.bucket === 'add' ? dd.items?.add : dd.items?.update;
          const x = arr?.[tag.idx];
          if (x) {
            x.name = edit.name.trim();
            // String() 兜底:type="number" 的 v-model 会把值转成 number,直接 .trim() 会抛错(number 无 trim)。
            const qtyStr = String(edit.qty).trim();
            const q = Number(qtyStr);
            if (qtyStr && Number.isFinite(q)) x.qty = q;
            else delete x.qty;
            if (edit.desc.trim()) x.desc = edit.desc.trim();
            else delete x.desc;
          }
        }
      } else if (tag.key.startsWith('npc:')) {
        if (tag.bucket === 'remove') {
          if (dd.npcs?.remove) dd.npcs.remove[tag.idx] = edit.name.trim();
        } else {
          const arr = tag.bucket === 'add' ? dd.npcs?.add : dd.npcs?.update;
          const x = arr?.[tag.idx];
          if (x) {
            x.name = edit.name.trim();
            // 各档案/即时字段走注册表:有值即写、留空即删该键(空字段不落进 delta)。
            // 本轮未渲染的字段其草稿已被 editTag 清空 → 会 delete,但它本就不在 delta,无副作用。
            const rec = x as unknown as Record<string, unknown>;
            const prevAge = x.age;
            for (const f of NPC_FIELDS) {
              const t = (edit[f.draft] as string).trim();
              // 好感说明的空字符串是显式清空;省略才是保留上一层,不能混用。
              if (t || (f.key === 'affinityNote' && x.affinityNote !== undefined)) rec[f.key] = t;
              else delete rec[f.key];
            }
            for (const { key } of NPC_AFFINITY_FIELDS) {
              // update 未提供的一侧必须继续省略,不能因编辑另一侧而写成未知。
              if (x[key] !== undefined || (tag.bucket === 'add' && edit[key] !== '')) {
                x[key] = affinityLevelFromInput(edit[key]);
              }
            }
            // 年龄被改动时清掉 delta 里可能残留的旧锚点(手动编辑写入的 ageTime),
            // 让重放按本叶子时间盖新锚点;没改则保留原锚点不动。
            if (x.age !== prevAge) delete rec.ageTime;
          }
        }
      } else if (tag.key.startsWith('plan:add:')) {
        const x = dd.plans?.add?.[tag.idx];
        if (x) x.content = edit.content.trim();
      } else if (tag.key.startsWith('var:')) {
        const op = dd.varOps?.[tag.idx];
        if (op) {
          op.path = edit.varPath.trim();
          // 按命令类型写回对应字段(只改本类型有的字段,避免残留无关字段)
          if (op.op === 'add') {
            const n = Number(String(edit.varDelta).trim());
            op.delta = Number.isFinite(n) ? n : 0;
          }
          if (op.op === 'set' || op.op === 'assign') {
            op.value = parseVarValue(edit.varValue);
          }
          if (op.op === 'assign' || op.op === 'remove') {
            const k = edit.varKey.trim();
            if (k) op.key = k; // 纯数字键作数组下标由重放侧 Number() 兜底,存字符串即可
            else delete op.key;
          }
        }
      }
    });
  }

  /** 删除某条变动(从对应桶按序号剔除)。 */
  function deleteTag(tag: DeltaTag) {
    const [cat, bucket] = tag.key.split(':');
    commitDelta(dd => {
      if (cat === 'protagonist') {
        delete dd.protagonist;
        return;
      }
      if (cat === 'var') {
        if (Array.isArray(dd.varOps)) dd.varOps.splice(tag.idx, 1); // varOps 是扁平数组,直接按序号删
        return;
      }
      const group = (dd as Record<string, Record<string, unknown[]>>)[cat === 'item' ? 'items' : cat === 'npc' ? 'npcs' : cat === 'scene' ? 'scenes' : cat === 'secret' ? 'secrets' : 'plans'];
      const arr = group?.[bucket];
      if (Array.isArray(arr)) arr.splice(tag.idx, 1);
    });
  }

  return {
    editKey, edit, setFocus, onTextInput, onFieldKeydown, cancelEdit,
    editText, saveText, editTime, saveTime, editLoc, saveLoc,
    editingVarOp, npcEditFields, npcAffinityEditFields,
    editTag, saveTag, deleteTag,
  };
}

export type LeafEdit = ReturnType<typeof useLeafEdit>;
export const LEAF_EDIT: InjectionKey<LeafEdit> = Symbol('bbs-fp-leaf-edit');
