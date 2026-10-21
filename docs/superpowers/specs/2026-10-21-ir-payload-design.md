# IDT IR 装配载荷设计

## 目标

让模型拿到足够的信息产出通过校验的 StateTransitionIR。当前在财达宿主上，任何意图都编译不出 spec，根因是喂给模型的载荷里没有页面元素，也没有 IR 的结构说明。

## 现状：四个叠加的问题

在财达宿主上用 `打开拟调整融资额度页面` 实测，`gpt-5.6-sol`、`gpt-6-sol`、`DeepSeek-V4.1-Flash-1017`、`Qwen3-235B-A22B-Instruct-2507` 四个模型、两家厂商，产出完全一致：

```json
{ "initialRoute": "/credit/amount/finance", "stages": [], "unresolved": [ "…" ] }
```

`initialRoute` 每次都对，`stages` 每次都空。这不是模型能力问题。

### 一、`flowId` 不可能猜中

`StateTransitionIRSchema` 要求 `flowId` 匹配 `/^flow_[a-f0-9]{10}$/`，这个值由 `flowIdFromIntent(intent)` 哈希得出。`ir-compiler.ts:166-168` 在校验**之后**用引擎的权威值覆盖 `flowId`、`intent`、`oracle`，但 `parseAndValidate` 在覆盖之前就按 schema 校验了它们。模型被迫去猜三个注定被丢弃的字段，其中一个数学上猜不中。实测 4 条 zod 错误里有 2 条出在这儿。

### 二、载荷里没有 IR 的结构说明

`IR_SYSTEM_PROMPT` 只有四条行为约束，一个字段名都没提。`userPayload` 是 `{intent, proseCase, proseCaseTruncated, routeFlow, slices}`，同样不含 schema。模型只能靠猜字段名和取值范围，`targetRole` 的八个合法值、`actionType` 的四个合法值、`stages` 至少一条，它全都不知道。

### 三、页面元素根本没进载荷

`slices` 只从 `node.transitions[].codeSlice` 取。拓扑的 114 条路由里只有 24 条有 transitions，其余 90 条拿到的 `slices` 是空数组。

而 `ActionSchema` 要求 `targetRole`（八个 ARIA role 之一）和 `targetName`（可及名称）。拓扑里没有任何元素级数据——`semanticKeywords` 是裸文本，分不出哪个是按钮哪个是标题。模型没有任何材料可以产出一条 action，提示词又明确写了 `DO NOT invent`。它返回空 stages 是正确行为。

### 四、于是死锁

`emitSpec` 对非空 `unresolved` 直接抛错，`stages` 又有 `min(1)`。缺元素 → 模型只能填 unresolved → emit 必拒。90 条无出边路由在当前设计下永远产不出 spec。

## 前置修复：覆盖提前到校验之前

把 `flowId`、`intent`、`oracle` 的注入移到 `parseAndValidate` 之前，对解析出的对象先补这三个字段再交给 zod。

这一步独立于载荷设计，但挡在同一条路上，和本设计一起实施。提示词相应声明这三个字段由引擎填写，模型不必输出。

## 元素清单

`ActionSchema` 需要 role 和 name，所以拓扑必须带上每个页面的可交互元素。

### 复用已有的扫描器

`vue-sfc.ts` 的 `scanVueTemplate` 已经在做逐帧解析：`matchOpenTag` 读标签和属性，`classifyTag` 分类，`finishFrame` 收集帧内可见文本。它目前只保留 `kind` 为 `link` 和 `click` 的帧，其余全部丢弃，只把裸文本并进 `texts`。

所以不新写解析器，只在 `finishFrame` 增加一路输出：元素清单。

### 角色映射

| 来源 | role |
| --- | --- |
| `<button>`、`<van-button>`、`role="button"` | `button` |
| `<router-link>`、`<a>` 带 `href` 或 `to` | `link` |
| `<input>` 的 `text`/`number`/`tel`/`password`/`search`、`<textarea>`、`<van-field>` | `textbox` |
| `<input type="checkbox">`、`<van-checkbox>`、`<van-switch>` | `checkbox` |
| `<input type="radio">`、`<van-radio>` | `radio` |
| `<select>`、`<van-picker>`、`<van-dropdown-item>` | `combobox` |
| `<h1>`–`<h6>`、`<van-nav-bar>` 的 `title` | `heading` |
| `<van-tab>`、`role="tab"` | `tab` |

映射表放在单独的常量里，按标签名小写匹配，宿主用别的组件库时只改这张表。表里没有的标签不进清单。

### 可及名称

取值顺序：`aria-label` → textbox 取 `label` 或 `placeholder` → 帧内可见文本 → `title` 属性。

值里含 `{{ }}` 插值或绑定前缀（`:`、`v-bind:`）的，名称判定为动态。动态元素仍然进清单，但带 `dynamic: true` 且不给 `name`。模型据此知道"这里有个按钮但名字运行时才定"，可以写进 `unresolved` 而不是瞎编一个名字。

同一路由内 role 与 name 都相同的元素去重，保留第一个。

**实施后的修订（2026-10-21，真实宿主实测）**：原表里把「带 `@click` 的 `div`/`span`」也映射成 `button`，这是错的。财达登录页的"去登录""立即登录"都是这种写法，Playwright 的 aria 快照里它们只是 `text`，没有 `button` role，`getByRole('button')` 永远定位不到。

更关键的是 **heal 救不了这一类**：自愈只在同一个 role 内部换 `targetName`，role 本身错了就没有候选可选（实测报「aria 快照里没有足够接近 X 的 button。候选：（无）」）。

已去掉这条推断，只有真的渲染成 `button` 的标签和显式 `role="button"` 才进清单。财达的元素总数因此从 206 收缩到 67，但剩下的每一个都能被 `getByRole` 定位。可点 `div` 需要 `getByText` 这类定位方式，而 `TargetRoleSchema` 只有八个 ARIA role，装不下——这是后续的设计问题，记在这里。

### 这是候选，不是保证

Playwright 的 `getByRole(role, { name })` 用的是运行时可及名称。静态推断会在 i18n、`v-if`、插槽、运行时拼接这些地方和真实 DOM 对不上。

清单的职责是给模型一个有依据的候选集，取代现在的凭空想象。对不上的那部分由 `heal` 用运行时 aria 快照修正——这正是自愈环节存在的理由。提示词要写明清单是候选，`targetName` 只能从清单里选，选不到就进 `unresolved`。

## 拓扑产物

`RouteTopologyNodeSchema` 增加可选字段：

```json
"elements": [
  { "role": "button", "name": "全部" },
  { "role": "textbox", "name": "拟调整融资额度" },
  { "role": "button", "dynamic": true, "tag": "van-button" }
]
```

设为可选、`version` 不升。读到缺失按空数组处理，既有宿主产物不作废，理由同 hash 路由那份设计。

## 新的载荷

`userPayload` 改为：

```ts
{
  intent,
  proseCase,
  proseCaseTruncated,
  routeFlow,            // 不变
  pages: [              // 新增，按 routeFlow 顺序
    { route, title, semanticKeywords, elements }
  ],
  slices,               // 不变
}
```

`pages` 只取 `routeFlow` 上的路由，不是整个拓扑，避免把 114 条路由全塞进上下文。

### 提示词补充 schema

`IR_SYSTEM_PROMPT` 增加一段精简的结构说明：字段名、`targetRole` 与 `actionType` 的合法取值、`stages` 至少一条、`flowId`/`intent`/`oracle` 由引擎填写不要输出。不贴完整 JSON Schema，只给模型需要决策的部分。

## 纯导航用例必须成立

`stages` 的 `min(1)` 对"只打开一个页面"的意图是合理的：那就是一条 stage，`actions` 为空数组，`invariants.network` 为空，用 `routeGuard` 的 `readyRole` 和 `readyName` 断言页面就绪。

提示词要给出这个形态的例子，并写明：元素清单为空或意图不含任何操作时，产出单条无动作 stage，**不要**往 `unresolved` 里写"没有代码片段"。

这一条单独解掉 90 条无出边路由的困境——它们至少能产出"打开并断言"级别的 spec。跨页流程仍然受限于拓扑边稀疏（114 条路由只有 34 条边），那是 transitions 提取的问题，不在本设计范围。

## 收紧 unresolved 的语义

`unresolved` 只写**真正不可判定的操作**：意图要求点某个按钮但清单里没有、要求填某个值但没有对应输入框、名称是动态的无法定位。

"没有提供代码片段"这类对载荷本身的抱怨不属于 `unresolved`。实测两个模型都往里写了这类内容，直接导致 `emitSpec` 拒绝。提示词明确区分。

## 不在本设计范围

运行时 aria 快照增强载荷（`gen` 之前先跑一次页面取真实 DOM）。它能根治静态推断的偏差，但要求宿主能起开发服务器，财达宿主目前被 pnpm 和登录态挡着。留作后续。

拓扑边稀疏导致的跨页寻径失败。

## 测试策略

严格按 TDD 实施：

1. `flowId`/`intent`/`oracle` 在校验之前注入，模型不输出这三个字段也能通过；
2. 模型输出的这三个字段的值被忽略，最终 IR 用引擎的权威值；
3. 角色映射表对每一类标签给出正确 role，表外标签不进清单；
4. 可及名称按 `aria-label` → `label`/`placeholder` → 可见文本 → `title` 的顺序取；
5. 含插值或绑定的名称标记 `dynamic: true` 且不给 `name`；
6. 同路由内 role 与 name 都相同的元素去重；
7. 拓扑写出 `elements`；缺少该字段的旧拓扑按空数组读入且不报错；
8. 载荷包含 `pages`，且只含 `routeFlow` 上的路由；
9. 载荷和提示词都不含密钥（沿用 `redactSecrets`，元素名称一并过）；
10. 无动作意图产出单条空 actions 的 stage，且 `unresolved` 为空；
11. 意图要求的元素不在清单里时进 `unresolved`，且 `emitSpec` 按既有规则拒绝；
12. `pnpm test:idt` 和 `pnpm exec tsc --noEmit` 全部通过。

单测不访问网络，模型用桩。

## 完成标准

- 财达宿主执行 `pnpm idt:sync` 后，`/credit/amount/finance` 的拓扑节点带上 `elements`；
- `pnpm idt "打开拟调整融资额度页面"` 产出通过校验的 IR 与 spec，`unresolved` 为空；
- 产出的 spec 里 `targetName` 全部来自元素清单，没有凭空捏造的名称；
- 既有 fixture 的 spec 产物逐字节不变；
- 全量类型检查与单元测试通过。
