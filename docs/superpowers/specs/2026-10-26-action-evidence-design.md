# 动作硬证据设计

## 目标

让「点击、勾选、选择」这类动作产出**真能失败**的断言。当前它们产出的是假绿灯。

## 问题：实测出来的假绿灯

2026-10-26 在活动项目 `quanshang/huodong` 的 `/h5/exchange` 上生成了全项目第一条
带真实动作的用例（Flash 档模型一次成功，1.3 秒跑过）：

```js
await page.goto("/#/h5/exchange");
await page.getByRole("textbox", { name: "请输入第一创业证券客户号" }).fill("88888888");
await page.getByRole("button", { name: "点击领取" }).click();
await page.waitForURL(new RegExp("#/h5/exchange"));
await expect(page).toHaveURL(new RegExp("#/h5/exchange"));
await expect(page.getByRole("textbox", { name: "请输入第一创业证券客户号" })).toBeVisible();
```

点击之后的两条断言——URL 没变、输入框还在——**都不是点击的下游效果**。
写探针把接口 abort 掉验证：

```
[探针] 正常情况：发出了接口请求 true，弹窗元素数 1，
       文本「你的客户号为: 88888888 未满足领取条件」
[探针] 接口全程失败：生成的三条断言依然全过
```

这正是需求文档开头问题表的第 2 行：「假绿灯——产品已经错了，测试仍通过」。

### 模型没错

IR 的 `setup.notes` 里模型自己写了：

> payload 未提供代码切片，因此不声明任何网络断言

它知道自己没证据、拒绝编造，完全符合原则 4。问题全在上游两层。

### 第一层：载荷里没有这个接口

`userPayload.slices` 只从 `node.transitions[].codeSlice` 取，而 transition 是
**路由跳转**。一个「调接口但不跳页」的点击产生不了 transition，所以模型根本
看不见 `src/service/exchange.js` 里的 `getBrokerageCode`。

### 第二层：闸门被同义反复绕过

验收 5 的规则是「既无网络契约**也无**路由守卫才拒绝」。这条 IR 有守卫，但
`targetUrlPattern` 是 `/h5/exchange`——它自己所在的那一页。对一个不跳页的点击
恒为真。

第二层已经修掉了（`verify` 的 `tautological-guard`，commit 6a49c54）。本设计解
第一层，并补上它暴露出的更大问题。

## 调查：两类宿主，处境完全不同

动手之前先数了一遍真实代码，结论直接改变了设计范围。

| | 活动项目 yichuang | 八个券商宿主 |
| --- | --- | --- |
| WebSocket / protobuf 引用 | 0 | **55**（仅 caida/src） |
| axios / request 调用 | 全部接口走它 | **3** |
| 字面量 `url:` | 每个 service 函数一条 | 全仓 8 个 app 合计 **8 处** |
| 形态 | `url: '/oabase/api/...'`，可静态解析 | `${VUE_APP_BASE}/api/...` 模板，且只覆盖验证码/公告/简报 |

券商的页面数据走 `ws://.../shenshu` + protobuf。`page.waitForResponse` 断言不了
WebSocket 帧，`NetworkInvariantSchema` 的 method/url/status/json 也表达不了。

**所以只做静态 HTTP 抽取，救得了活动类项目，救不了八个券商。** 两部分都要做。

---

## A. 静态抽取 HTTP 契约

### 复用已有的 import 遍历

`src/idt/extract/component-nav.ts` 已经有 `resolveImportSpecifier` 和 `walkImports`，
现在用于顺着页面的 import 收集子组件里的跳转和元素。同一套机器换一个收集器即可。

新增 `src/idt/extract/service-calls.ts`：

```ts
export interface ServiceCall {
  /** 导出的函数名，比如 getBrokerageCode */
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** 可用于 res.url().includes() 的子串 */
  urlPattern: string;
  /** 相对项目根的 posix 路径，便于人核对 */
  where: string;
}

export function collectServiceCalls(
  pageFile: SourceFile,
  project: Project,
  depth: number,
): ServiceCall[];
```

### 认什么

在页面 import 到的模块里，找**导出的函数**，其函数体内存在一个对象字面量同时带
`url` 和 `method`。两者都只认字符串字面量或模板字面量。

`method` 取值规范化成大写，不在五个合法值里的跳过。

### 模板字面量只留静态尾部

`url: \`${VUE_APP_BASE}/api/misc/notice\`` → `urlPattern: '/api/misc/notice'`。

能这么做是因为装配器渲染的是子串匹配：

```js
res.url().includes("/api/misc/notice") && res.request().method() === "GET"
```

规则：取模板里**最后一个 `${}` 之后**的静态部分。整条模板没有静态尾部（比如
`` `${base}${path}` ``）就丢弃这条，不猜。

### 载荷

`pages[]` 的每一项增加：

```json
"serviceCalls": [
  { "name": "getBrokerageCode", "method": "GET",
    "urlPattern": "/oabase/api/softuser/v2/exchange-code/get-exchange-code-by-brokerage-code" }
]
```

`where` 不进载荷，只留在拓扑里供人核对，省上下文。

### 提示词

规则 5 现在写的是：

> Network invariant method, urlPattern, expectedStatus, and assertResponseFields
> must strictly come from code slices or prose case assertions.

改为同时认 `serviceCalls`，并补一条：**这一页能发哪些请求 ≠ 某个按钮一定发其中哪条**。
静态上只知道前者。模型要做的对应属于概率的一部分，错了由运行期暴露。
对不上就别声明网络契约，宁可让闸门拒绝。

### A 做不到什么

- 不保证抽到的接口真的被那个动作触发；
- 运行期拼出来的 url、函数套函数转发的，抽不到；
- 对八个券商基本无效——它们没有 HTTP 可抽。

---

## B. 动作后的 DOM 增量，作为第一类证据

A 补完之后，券商那边仍然一条动作用例都产不出。而且即使有 HTTP，最直接的证据
往往也不是「发了个请求」，而是**「本来没有的东西出现了」**。

`/h5/exchange` 就是这样：点击的真实效果是弹出带兑换码的对话框。按代码走，
`getBrokerageCode(...).then(...)` 在请求失败时不执行，弹窗不会出现——所以
「弹窗出现」是一条会真失败的断言。（这一条是读代码得出的，探针只实测了正常
情况下弹窗出现。）

### 新的不变量

```ts
export const DomDeltaSchema = z.object({
  appearedRole: TargetRoleSchema,
  appearedName: z.string().min(1),
});
```

挂在 `stage.invariants.domDelta`，可选。装配器在触发动作之后渲染：

```js
await expect(page.getByRole("dialog").filter({ hasText: "未满足领取条件" })).toBeVisible({ timeout });
```

### 它从哪来：探针

静态分析不可能知道点击之后会冒出什么。但**运行期跑一次就知道**，而且这套机器
已经有了——`heal` 就是靠 `replayUntil` + `ariaSnapshot` 工作的。

新增 `idt probe <ir>`：

1. 用 `replayUntil` 执行到目标动作**之前**，取一次 aria 快照；
2. 执行该动作，等一个短超时，再取一次；
3. 两次快照求差，得到新出现的 `(role, name)` 列表；
4. 候选唯一时写进 IR 的 `domDelta` 并重新 emit；多个候选时列出来让人选，不擅自写；
5. 一个都没有时报告「这个动作没有可观察的 DOM 效果」，退出码 2。

第 4 步的「多候选不擅自写」沿用 `heal` 的既有判断方式（相似度阈值、第一第二名
分差），不另造一套。

### 这不违反「概率只留在编译期」

探针在**开发者本机**跑，结果固化进 IR，CI 只跑固化后的脚本。和 `--yes`、`heal`
是同一类操作。CI 环境依然不配模型密钥、不跑探针。

### 闸门相应放宽

需要硬证据的动作（CLICK / CHECK / SELECT），证据从二选一变成三选一：

1. 一条网络契约；
2. 一条**真的跳页**的路由守卫（`targetUrlPattern` 不等于本 stage 的 `routePattern`）；
3. 一条 `domDelta`。

`verify` 的 `tautological-guard` 和装配器的拒绝规则同步改成这三条。

---

## 不在本设计范围

- **WebSocket 帧断言。** 券商的 protobuf 帧要解码才能断言内容，需要引入 proto 定义，
  是独立的一摊。B 方案让券商先能用 DOM 增量，够不够用要跑过才知道。
- **动作与请求的自动对应。** A 只提供候选，对应关系交给模型。
- **探针的并发执行。** 一次一条，先把正确性做对。

## 测试策略

严格 TDD。

A 部分：

1. 从导出函数里抽出 `url` + `method` 字面量；
2. 模板字面量取最后一个 `${}` 之后的静态尾部；
3. 整条模板没有静态尾部时丢弃，不猜；
4. `method` 规范化成大写，非法值跳过；
5. 只带 `url` 不带 `method`（或反之）的对象不收；
6. 顺 import 深度 1 能收到 `src/service/*` 里的定义，深度 0 收不到；
7. 载荷的 `pages[].serviceCalls` 只含该路由能达到的调用；
8. 载荷和提示词都不含密钥（沿用 `redactSecrets`，`urlPattern` 一并过）。

B 部分：

9. 快照求差只返回新出现的 `(role, name)`，消失的和不变的都不算；
10. 唯一候选时写进 IR 并重新 emit，产物包含该断言；
11. 多候选时不改文件，列出候选，退出码 2；
12. 零候选时不改文件，报告「无可观察效果」，退出码 2；
13. 装配器为 `domDelta` 渲染出的断言落在触发动作之后；
14. 三选一闸门：三种证据各自单独存在时放行，一个都没有时拒绝且退出码 2；
15. `verify` 的 `tautological-guard` 在有 `domDelta` 时不再报错。

## 完成标准

- `/h5/exchange` 那条意图重新生成后，`verify` 不再报 `tautological-guard`；
- 对它跑 `idt probe`，IR 拿到 `domDelta`，重新 emit 的 spec 在接口被 abort 时**失败**
  （用本设计开头那个探针的方式复验）；
- 八个券商里至少挑一条带点击的意图，走 B 路径产出能真失败的用例；
- 既有 fixture 的 spec 产物逐字节不变；
- 全量类型检查与单元测试通过。
