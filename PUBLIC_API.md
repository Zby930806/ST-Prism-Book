# 棱镜宝书公开读取接口（API v1）

本文面向 SillyTavern 插件、脚本和预设作者。棱镜宝书提供三种只读入口：

1. JavaScript 全局 API：`globalThis.STBaiBaiBook`
2. STscript 斜杠命令：`/bbs-get`
3. ST 宏：`{{bbsVars}}`、`{{bbsVar::路径}}` 等

公开接口只返回深拷贝 DTO，不暴露 Vue 响应式对象、聊天消息引用或写入方法。外部代码修改返回值不会改动棱镜宝书数据。

## 兼容约定

- `apiVersion` 当前固定为 `1`，它是公开数据结构版本，与插件自身的 `pluginVersion` 分开。
- 楼层编号统一使用 SillyTavern 的零基 `mesid`。
- `at: "before"`：状态不包含目标楼，即只重放 `mesid < floor` 的摘要增量。
- `at: "after"`：状态包含目标楼，即重放 `mesid <= floor` 的摘要增量；这是默认值。
- 标记为番外的 `bbs_omit` 楼层始终被忽略。
- 无效、串页或缺失的叶子摘要不会参与状态重放。
- 接口读取能力不依赖“棱镜宝书 · 记忆引擎”总开关是否开启。

完整快照、历史和楼层上下文 DTO 会返回覆盖信息：

```js
coverage: {
  complete: false,
  missingAiFloors: [38, 41],
}
```

消费方不应在 `complete === false` 时把结果当作无缺口的完整记忆。`missingAiFloors` 只统计当前查询截止点之前、应有摘要但没有有效摘要的 AI 楼；番外楼不计入。

`getVar()` 以及 `query({ resource: "state" })` 等快捷资源只返回目标值，不附带覆盖信息。需要判断完整性时，应同时读取 `getSnapshot()`，或直接从快照中取对应字段。

## 等待接口就绪

插件加载顺序不固定。推荐先检查全局对象，未就绪时再监听事件：

```js
function useBaiBaiBook(callback) {
  if (globalThis.STBaiBaiBook) {
    callback(globalThis.STBaiBaiBook);
    return;
  }

  window.addEventListener(
    'st-baibai-book:ready',
    () => callback(globalThis.STBaiBaiBook),
    { once: true },
  );
}
```

接口就绪后可检查能力：

```js
const api = globalThis.STBaiBaiBook;

console.log(api.apiVersion);     // 1
console.log(api.pluginVersion);  // 棱镜宝书插件版本
console.log(api.capabilities);
```

`capabilities` 的结构：

```js
{
  globalApi: true,
  slashCommand: true,
  macros: true,
  parameterizedMacros: true,
  events: true,
}
```

若宿主版本不支持某个注册入口，对应字段会是 `false`。旧宏引擎支持固定无参数宏，但不支持参数化宏，因此通常是 `macros: true`、`parameterizedMacros: false`。

## JavaScript API

### 读取当前快照

```js
const snapshot = globalThis.STBaiBaiBook.getSnapshot();

console.log(snapshot.state);
console.log(snapshot.protagonist);
console.log(snapshot.vars);
console.log(snapshot.items);
console.log(snapshot.plans);
console.log(snapshot.scenes);
console.log(snapshot.npcs);
console.log(snapshot.itemLog);
console.log(snapshot.lifeDetails);
```

主要返回结构：

```js
{
  apiVersion: 1,
  pluginVersion: "1.0",
  revision: 12,
  chat: {
    id: "聊天文件标识",
    characterName: "角色名",
    groupId: null,
    length: 86,
  },
  point: {
    floor: 85,
    at: "after",
    upToExclusive: 86,
  },
  coverage: {
    complete: true,
    missingAiFloors: [],
  },
  state: { time: "...", location: "...", locationPath: [] },
  protagonist: {
    gender: "女",
    identity: "调查员",
    appearance: "黑色短发，左眉有疤",
    outfit: "深色风衣",
    condition: "左臂轻伤",
  },
  vars: {},
  items: [],
  plans: [],
  scenes: [],
  npcs: [],
  itemLog: [],
  lifeDetails: [],
}
```

`snapshot.npcs` 中每个角色可带独立的内心好感与外在态度估计（不是自定义变量，也不是可加减的分数）：

| 字段 | 含义 |
| --- | --- |
| `affinityInner` | 内心好感（对 user）：`-2` 强烈反感、`-1` 不喜欢、`0` 无明显好恶、`1` 有好感、`2` 感情深厚 |
| `affinityOuter` | 外在态度（对 user）：`-2` 明显敌对、`-1` 冷淡疏远、`0` 不明显亲近或排斥、`1` 友善亲近、`2` 明显亲近、积极表达 |
| `affinityNote` | 一句依据、表现或矛盾说明 |

两侧都可能缺失或为 `null`，表示未知，不能按 `0` 处理。楼层 delta 中省略字段表示保持，`null` 表示撤回该侧估计，`affinityNote: ""` 表示清空说明。估计不等于已证实的心理事实，也不代表爱情、信任、服从或同意。

`snapshot.lifeDetails` 为按人物记录的生活小档案。`subject: "user"` 表示主角，其他字符串为角色在 NPC 名册中的名字；旧叶子缺少 `subject` 时按原有主角专用语义处理，不从正文猜人物。`text` 是该人物的细节正文，显示或注入时会加上姓名。相同内容按人物分别去重，不能跨人合并。

```js
{ subject: "user", text: "认为煎饼果子不加脆饼就没有灵魂", topics: ["饮食"], anchors: ["煎饼果子"], tier: "active" }
{ subject: "艾琳", text: "喝茶不加糖", topics: ["饮食"], anchors: ["茶"], tier: "active" }
```

楼层 `lifeDetails.update` 省略 `subject` 保持原人物，显式写 `"user"` 可纠正回主角；自动记录限主角与主要角色的明确事实。手动 NPC 改名同步生活条目的归属，删除角色不会删除其历史生活档案。置顶/关键词触发/时效及沉降规则不变，换对话也会保留归属。

读取某楼之前或之后的状态：

```js
const before = globalThis.STBaiBaiBook.getSnapshot({
  floor: 42,
  at: 'before',
});

const after = globalThis.STBaiBaiBook.getSnapshot({
  floor: 42,
  at: 'after',
});
```

### 读取变量

变量路径与棱镜宝书内部一致，支持点号和数字数组下标：

```js
const favor = globalThis.STBaiBaiBook.getVar('关系.爱丽丝.好感度');
const hp = globalThis.STBaiBaiBook.getVar('队伍[0].hp', {
  floor: 42,
  at: 'after',
});
```

路径不存在时返回 `undefined`。传入空路径 `""` 会返回整棵变量树。

### 读取历史剧情

```js
const history = globalThis.STBaiBaiBook.getHistory({
  before: 42,
});

console.log(history.text);
console.log(history.relativeText);
console.log(history.nodes);
console.log(history.coverage);
```

`before: 42` 只包含 `mesid < 42` 的剧情。`text` 是只带绝对时间、按时间顺序拼好的压缩历史文本；`relativeText` 会额外加入“昨天”“三天前”和周几等相对时间，参照点是本次查询截止位置之前的最新故事时间。`nodes` 同时提供每个被选中摘要/总结节点的层级、时间和覆盖楼层范围。

棱镜宝书会优先使用可完整代表一段历史的最高层总结；若总结节点存在失效后代，则自动拆回仍然有效的下层节点。

### 读取正常注入口径的历史剧情

```js
const injectedHistory = globalThis.STBaiBaiBook.getInjectedHistory();

console.log(injectedHistory.relativeText);
console.log(injectedHistory.nodes);
console.log(injectedHistory.coverage);
```

`getInjectedHistory()` 与棱镜宝书正常记忆注入共用同一套节点选择规则：只返回正文已经隐藏、已离开滑动窗口的有效摘要，并使用当前最新故事时间生成相对时间。`relativeText` 是宏和正常注入使用的历史正文；`text` 是相同节点的纯绝对时间版本。

返回值不包含棱镜宝书内部注入槽使用的外围提示语，只包含历史剧情正文。

### 读取单楼

```js
const floor = globalThis.STBaiBaiBook.getFloor(42);

console.log(floor.body);             // 按棱镜宝书规则清洗后的楼层正文
console.log(floor.omitted);          // 是否番外
console.log(floor.memory.valid);     // 是否有当前页可用摘要
console.log(floor.memory.summary);
console.log(floor.memory.delta);
```

`memory.stored` 表示消息上物理存在叶子数据；`memory.valid` 才表示该叶子属于当前 swipe、未被番外规则排除并可用于查询。无效叶子的旧摘要和增量不会公开为有效结果。

### 一次读取某楼完整上下文

这是“某楼状态快照 + 之前历史剧情”的推荐入口：

```js
const context = globalThis.STBaiBaiBook.getContextAtFloor({
  floor: 42,
});

console.log(context.floorData);
console.log(context.floorSummary);
console.log(context.floorDelta);
console.log(context.snapshotBefore);
console.log(context.snapshotAfter);
console.log(context.historyBefore.text);
console.log(context.coverage);
```

### 通用 query

```js
const result = globalThis.STBaiBaiBook.query({
  resource: 'var',
  path: '关系.爱丽丝.好感度',
  floor: 42,
  at: 'after',
});
```

支持的 `resource`：

```text
var, vars, state, protagonist, items, plans, scenes, npcs, itemLog,
snapshot, history, injectedHistory, floor, context
```

- `var` 需要 `path`。
- `floor`、`context` 需要 `floor`。
- `history` 使用 `before`；也接受 `floor` 作为截止点别名。
- `injectedHistory` 无需额外参数，使用正常记忆注入的滑动窗口过滤规则。
- 其余状态资源可选 `floor` 和 `at`。

## 变更通知

通过 API 订阅：

```js
const unsubscribe = globalThis.STBaiBaiBook.subscribe(notice => {
  console.log(notice.type, notice.revision, notice.chatId);
  const latest = globalThis.STBaiBaiBook.getSnapshot();
});

// 插件卸载时
unsubscribe();
```

也可监听 DOM 事件：

```js
window.addEventListener('st-baibai-book:changed', event => {
  console.log(event.detail);
});
```

事件名：

- `st-baibai-book:ready`
- `st-baibai-book:changed`

事件 `detail` 与订阅通知均包含：

```js
{
  type: "ready" | "changed",
  apiVersion: 1,
  pluginVersion: "1.0",
  revision: 12,
  chatId: "...",
  capabilities: {},
}
```

连续发生的内部更新可能合并为一次 `changed` 通知。消费方应把通知理解为“数据可能已变化”，收到后重新调用查询方法，不要自行猜测增量。

## `/bbs-get` 斜杠命令

默认输出紧凑 JSON，可直接进入 STscript 管道：

```text
/bbs-get resource=snapshot
/bbs-get resource=var path="关系.爱丽丝.好感度" floor=42 at=after format=raw
/bbs-get resource=history before=42 format=text
/bbs-get resource=injectedHistory format=text
/bbs-get resource=floor floor=42 format=json
/bbs-get resource=context floor=42 format=json
```

也可以把资源名作为第一个无名参数：

```text
/bbs-get snapshot
/bbs-get history before=42 format=text
/bbs-get injectedHistory format=text
```

参数：

| 参数 | 含义 |
| --- | --- |
| `resource` | 与 JavaScript `query()` 相同的资源名，默认 `snapshot` |
| `path` | `var` 使用的变量路径 |
| `floor` | 零基 ST `mesid` |
| `at` | `before` 或 `after`，默认 `after` |
| `before` | 历史截止楼层，不包含该楼 |
| `format` | `json`、`raw` 或 `text` |

格式规则：

- `json`：默认；始终输出合法紧凑 JSON，缺失变量为 `null`。
- `raw`：字符串/数字/布尔值不带 JSON 引号；对象和数组仍输出紧凑 JSON。
- `text`：普通历史返回绝对时间正文；注入口径历史返回与正常注入相同的相对时间正文；单楼返回摘要（无摘要则返回清洗后的正文）；楼层上下文返回“此前历史 + 本楼摘要”。

## ST 宏

### 新旧宏引擎都支持

```text
{{bbsVars}}       当前变量树，紧凑 JSON
{{bbsState}}      当前时间/地点状态，紧凑 JSON
{{bbsSnapshot}}   当前完整快照，紧凑 JSON
{{bbsHistory}}    当前全部压缩历史，带相对时间的纯文本
{{bbsInjectedHistory}} 与正常记忆注入相同，跳过滑动窗口内摘要
```

### 新宏引擎支持参数

```text
{{bbsVar::关系.爱丽丝.好感度}}
{{bbsVar::队伍[0].hp::42::after}}
{{bbsSnapshot::42::before}}
{{bbsSnapshot::42::after}}
{{bbsHistory::42}}
{{bbsFloor::42}}
```

`{{bbsHistory}}` 和 `{{bbsHistory::42}}` 返回 `getHistory(...).relativeText`。后者只包含 `mesid < 42` 的剧情，并以第 42 楼之前的最新故事时间计算“昨天”“三天前”和周几等标记。

`{{bbsInjectedHistory}}` 返回 `getInjectedHistory().relativeText`，与正常记忆注入使用相同的节点选择和相对时间规则，因此会自动跳过滑动窗口内仍发送全文的摘要。

宏中的字符串值原样返回；数字和布尔值转为字符串；对象和数组使用紧凑 JSON；`null`、不存在的变量或查询错误返回空字符串。

旧版宏引擎只能使用五个无参数宏。需要参数化读取时，应检查：

```js
globalThis.STBaiBaiBook.capabilities.parameterizedMacros
```

若为 `false`，改用 `/bbs-get` 或 JavaScript API。

## 错误与边界

- `floor` 必须是当前聊天内有效的整数 `mesid`，否则 JavaScript API 会抛出 `TypeError` 或 `RangeError`。
- `before` 可取 `0` 到 `chat.length`；它表示排他的截止索引。
- 当前没有打开聊天时，末尾快照和历史返回空结果；需要具体楼层的方法会因无有效楼层而抛错。
- API DTO 可自由缓存和修改，但它是读取时刻的副本；需要最新值时重新查询并比较 `revision`。
- 不要读取棱镜宝书内部的 `memory` 响应式对象或直接解析 `chatMetadata`。这些属于内部实现，不受 API v1 兼容承诺保护。

公开 TypeScript 类型定义位于 `src/public/types.ts`。
