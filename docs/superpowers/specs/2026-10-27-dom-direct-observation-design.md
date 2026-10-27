# probe 改用 DOM 直取替代 aria 字符串解析

## 目标

把 probe 的观测通道从「解析 `ariaSnapshot()` 的字符串输出」换成「在页面里执行
JS 直接读 DOM」，让它能拿到每个元素**自己的**身份，而不是从一个已经丢掉信息
的表示里反推。

## 问题：信息在观测那一步就没了

2026-10-27 在财达宿主实测。`/plan/aiznwgIntro` 整页的 Playwright aria 快照：

```
- text:  智能网格 一键生成最优网格，一键跟投，自动下单 查看详情 箭
```

**一整页压成一行。** 「查看详情」在源 DOM 里是独立元素，到了快照里和周围说明
文字合并成了一个文本节点。这不是解析器的 bug——Playwright 就是这么输出的。

同一个页面，在页面里执行 JS 直接读 DOM：

```
[div] "智能网格"
    #app > div.aiznwg-intro > … > div.title.flex:nth-of-type(3) > div
[div] "一键生成最优网格，一键跟投，自动下单"
    #app > div.aiznwg-intro > … > div.tips-line.m-top-16:nth-of-type(2)
[div] "查看详情"
    div.aiznwg-intro > … > div.details-btn.flex:nth-of-type(1) > div
```

三个独立元素，各有各的文本，各有一条可复用的结构路径。连类名都是语义化的
（`details-btn`）。**文本块的问题根本不存在**，它是有损表示制造出来的。

### 这解释了之前的两次打补丁

- `aria-snapshot.ts` 原本丢掉所有无引号名的行 → 修了（commit 8469052）；
- `diffAriaSnapshots` 加了「text 角色且过长就不进候选」的过滤 → 那是权宜之计，
  把残骸扔掉而不是把信息找回来。

两者都是在有损通道上修修补补。换通道之后，过滤会变成死代码。

## 为什么不是「开发时给 div 加 role」

会有帮助，但不该做：

- 违背项目自己的约束——宿主业务源码不改。8 个券商 2732 个源文件，为了测试去
  改生产代码，方向反了；
- **不需要**。DOM 里已经有足够的身份信息：自有文本、语义类名、结构路径。
  缺的不是属性，是取数方式。

加 role 对无障碍本身是好事，但那是另一件事的理由。

## 为什么不是「运行时注入属性、跑完再去掉」

这个方向的**目标**对（拿到每个元素的身份），**机制**有三个问题：

1. **循环依赖。** 要给「查看详情」那个 div 注入 `role="button"`，得先能定位到
   它；能定位到它就不需要注入了。注入没有增加任何信息。
2. **改变了被测对象。** `role` 会改无障碍树，有组件库和 CSS 会对它起反应。
   跑完再去掉救不回来——那一次运行已经发生在被改过的页面上。
3. **多此一举。** 注入必须在页面里执行 JS；既然能执行 JS，直接读 DOM 更简单。

## 设计

### 观测函数

新增 `src/idt/core/dom-observe.ts`，导出一段在页面上下文执行的采集逻辑：

```ts
export interface ObservedElement {
  /** 标签名，小写 */
  tag: string;
  /** 显式 role 属性，没有就是 null */
  role: string | null;
  /** 元素【自己的】直接文本，不含子元素的 */
  ownText: string;
  /** img 的 alt */
  alt: string | null;
  /** 可复用的 CSS 路径 */
  css: string;
  /** 是否可见（rect 非零） */
  visible: boolean;
}

export function observeScript(): string;          // 返回注入页面的函数源码
export function parseObserved(raw: unknown): ObservedElement[];  // 校验 + 收窄
```

`ReplayPage` 增加一个方法：

```ts
observe(): Promise<ObservedElement[]>;
```

Playwright 侧用 `page.evaluate(observeScript())` 实现。

### 采集规则

**自有文本。** 只取元素的直接子文本节点，不含后代——这是避免文本块的关键。
父容器因此拿到空文本，自动被排除。

**可见性。** `getBoundingClientRect()` 宽高都为 0 的跳过。

**CSS 路径。** 从元素向上回溯，每层记 `tag`，有稳定类名就附上（过滤掉
纯数字开头和像哈希的类名——CSS Modules 和 scoped 样式会生成那种），同层同标签
有多个时加 `:nth-of-type(n)`。遇到 `id` 就以它收尾。最多回溯 6 层。

路径不保证全局唯一；**生成之后要在页面里用 `querySelectorAll` 验一次**，命中
多于一个就继续向上加层，加到 6 层仍不唯一就丢弃这个候选——宁可漏报也不要给出
一条会匹配到别的元素的选择器。

**不采集什么。** 不读 `innerHTML`、不读 `value`（可能含用户输入）、不读
`data-*` 里的任意内容。采集结果要过 `redactSecrets`。

### 差分

`dom-delta.ts` 增加与现有 `diffAriaSnapshots` 平行的：

```ts
export function diffObserved(
  before: ObservedElement[],
  after: ObservedElement[],
): ObservedElement[];
```

身份用 `css` 比较（不是文本——文本会变，位置相对稳定）。返回 after 里有、
before 里没有的，按 after 顺序，去重。

### IR 怎么存

`DomDeltaSchema` 现在是 `{ appearedRole, appearedName }`，只能表达
`getByRole` / `getByText`。DOM 直取能给出更精确的定位，需要加一种：

```ts
export const DomDeltaSchema = z.union([
  z.object({ appearedRole: AppearedRoleSchema, appearedName: z.string().min(1) }),
  z.object({ appearedSelector: z.string().min(1), appearedText: z.string().optional() }),
]);
```

装配器对第二种渲染 `page.locator(selector)`，带 `appearedText` 时加
`.filter({ hasText })`。

**优先用第一种。** `getByRole(role, {name})` 是语义定位，页面重构后比 CSS 路径
更耐改。只有当元素没有可用的 role/可及名称时（正是 `查看详情` 这种裸 div）
才退到选择器。probe 列候选时要标明每个候选是哪一种，让人知道自己在选什么。

### probe 的证据优先级

现在是：URL 变化 → DOM 增量。改完之后 DOM 增量这一支内部再分两层：

```
1. URL 变了                      → routeGuard（最强，已实现）
2. 新元素有 role + 可及名称      → domDelta 的 role/name 形式
3. 新元素只有文本和结构          → domDelta 的 selector 形式
4. 什么都没有                    → 报告无可观察效果，退出码 2
```

多候选仍然不替人选，仍然靠 `--pick`。

### 点击落在谁身上：附加观测

Vue 的 `@click` 编译成事件监听器，**属性上完全看不见**。实测那个页面连
`cursor: pointer` 都没设，所以连样式线索都没有。

可选增强：在重放前注入一个捕获阶段的监听器，记录这次点击实际命中的元素路径。

```js
document.addEventListener('click', (e) => { window.__idt_hit = cssPath(e.target); }, true);
```

这是**附加观测**，不是修改身份：不碰元素属性、不动无障碍树、页面行为不变，
与上面否掉的「注入 role」有本质区别。

它解决的是 DOM 读不出来的问题——谁真正处理了这次点击。作用是校验：如果点击
落在的元素和 IR 里 `targetName` 指的不是同一个，说明定位错了，probe 应当报出来。

**这一条放在第二阶段**，第一阶段先把采集和差分做对。

## 不在本设计范围

- **canvas 里画了什么。** 像素内容读不出来，这是真正需要视觉模型的地方，也是
  目前唯一还站得住的 VLM 用例。
- **heal 改用同一通道。** heal 也在用 `parseAriaSnapshot`，同样受文本合并之害。
  但它的候选选择逻辑（相似度阈值、第一第二名分差）要跟着改，另行处理。
- **替换现有的 aria 通道。** 两条通道并存，aria 作为回退。页面里执行 JS 失败
  （CSP、页面崩溃）时仍能退回 aria 快照拿到些东西。

## 测试策略

严格 TDD。采集逻辑在页面上下文执行，单测用**静态 HTML 夹具 + 真实 chromium**
跑——这一类测不进 `pnpm test:idt`（它不启动浏览器），放一个单独的脚本，
在 CI 里作为独立 job。纯函数部分（路径生成、差分、校验）照旧进单测。

纯函数：

1. `parseObserved` 对缺字段、类型不对的输入收窄成空数组，不抛
2. `diffObserved` 只返回 after 里新出现的，按 css 比较身份
3. `diffObserved` 去重并保持 after 顺序
4. 采集结果过 `redactSecrets`
5. `DomDeltaSchema` 两种形态都能通过校验，第三种形态被拒
6. 装配器对 selector 形态渲染 `page.locator(...)`，带文本时加 `.filter`
7. 装配器对 role/name 形态产物逐字节不变（回归）

浏览器（独立 job）：

8. 一个父容器包三段文本的夹具 → 采集出三个元素，各有自己的文本，父容器因
   自有文本为空而不出现
9. 同层同标签多个兄弟 → 路径带 `:nth-of-type` 且能唯一命中
10. 生成的每条 css 在页面里 `querySelectorAll` 命中数恰好为 1
11. 6 层回溯后仍不唯一的元素被丢弃，不产出歧义选择器
12. 隐藏元素（宽高为 0）不采集
13. **用财达 `/plan/aiznwgIntro` 的真实 DOM 做夹具**，断言能采到
    `查看详情` 自己的文本和一条唯一选择器

## 完成标准

- 对 `/plan/aiznwgIntro` 跑 probe，候选里出现 `查看详情` 自己的条目（而不是
  整页文本块），且给出的选择器在页面里唯一命中；
- 活动项目 `transfer` 那种纯图片页能采到 `<img alt>` 和结构路径——此前元素
  清单是 0；
- `diffAriaSnapshots` 的文本块过滤不再被触发（可以留着当回退通道的保险）；
- 既有 fixture 的 spec 产物逐字节不变；
- 全量类型检查与单元测试通过。
