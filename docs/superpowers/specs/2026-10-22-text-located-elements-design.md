# 可点元素的文本定位设计

## 目标

让元素清单收下"带 `@click` 但没有 ARIA role"的可点元素中**有静态文本**的那部分，用 `getByText` 定位。没有文本的不收。

## 现状与规模

财达 110 个页面里，被当前规则丢弃的可点元素有 195 个，分布在 57 个页面：

| 标签 | 数量 |
| --- | ---: |
| `<div>` | 154 |
| `<i>` | 22 |
| `<span>` | 8 |
| 其他业务组件 | 11 |

其中**带静态可见文本的只有 37 个**，其余 158 个没有文本（图标按钮之类）。

清单里有确定名字的元素会从 42 个涨到 79 个（+88%）。样例：`/credit/amount/finance` 的「全部」、`/credit/guarantee/trans` 的「确认」、`/credit/home/setting` 的「退出委托」——都是真实业务入口。

这些元素此前被丢掉是对的：把它们当成 `button` 会产出 `getByRole('button')` 这种永远定位不到的断言，而且 heal 救不了（自愈只在同 role 内换名字）。但完全不收也不对——它们是真能点的。

## 表示方式：伪 role `text`

`TargetRoleSchema` 增加一个取值 `text`。它不是 ARIA role，是"用文本定位"的标记。

选它而不是给 `ActionSchema` 加 `targetKind` 字段，理由是改动面小得多：schema 保持扁平，IR 的形状不变，模型的提示词只多一个取值，`emitter`、`replay`、`healer` 三处按同一个字段分支即可。

代价是语义上不纯——`text` 混在八个真 ARIA role 里。可接受：它在提示词和文档里都被明确说明为"文本定位"。

## 收录规则

标签不在角色映射表里、带 `@click` / `v-on:click`、且帧内有静态可见文本时，产出 `{ role: 'text', name: <文本> }`。

**没有文本的一律不收**，不产出 `dynamic: true` 占位。理由：`dynamic` 的语义是"有这个控件但名字运行期才定"，模型看到还能写进 `unresolved`；而图标按钮是**根本没有文本可定位**，收进来只会让模型反复尝试一个注定失败的方向。158 个无文本元素全部排除。

含插值的文本同样不收，规则与既有的 `dynamic` 判定一致——`保持在线 {{hours}} 小时` 剥掉插值后是残句，运行期匹配不到。

## 定位方式

`emitter` 对 `targetRole === 'text'` 产出：

```ts
page.getByText("全部", { exact: true })
```

用 `exact: true` 而不是默认的子串匹配，否则「全部」会命中「全部撤单」。

**不加 `.first()`。** 文本重复时 Playwright 的 strict mode 会报错，这是对的——与其悄悄点中第一个，不如让 spec 明确失败。重复文本意味着这个元素本来就不该用文本定位。

## 自愈的限制

`parseAriaSnapshot` 只认 `- role "name"` 形态的行。Playwright 的 aria 快照把纯文本输出成 `- text: 一长串` 且不带引号，解析不出来，而且多个文本节点会被合并成一行。

所以 **`role: 'text'` 的目标 heal 修不了**：候选集会是空的，失败时会报「aria 快照里没有足够接近 X 的 text」。这是已知限制，写进文档，不在本次解决。

真要支持，需要 `parseAriaSnapshot` 认 `- text:` 行并按分隔符切分，精度存疑，留待后续。

## 不在本设计范围

158 个无文本的图标按钮。它们需要 `data-testid` 或 `aria-label`，属于宿主应用该补的无障碍属性，引擎这边做不了。

## 测试策略

严格按 TDD 实施：

1. 带 `@click` 的 `div` / `span` / `i` 有静态文本时产出 `role: 'text'`；
2. 没有文本时完全不收，也不产出 `dynamic`；
3. 文本含插值时不收；
4. 已在角色映射表里的标签（`button`、`van-button` 等）仍走原路径，不被当成 text；
5. 显式 `role="button"` 优先于文本定位；
6. `role: 'text'` 与同名的真 role 元素不互相去重（role 不同就是不同元素）；
7. `emitSpec` 对 `targetRole: 'text'` 产出 `getByText(name, { exact: true })`，不带 `.first()`；
8. 其余 role 的产物逐字节不变，fixture 作为回归闸门；
9. `replay` 对 text 目标用同一套定位；
10. 提示词说明 `text` 的含义与适用场景；
11. `pnpm test:idt` 与 `pnpm exec tsc --noEmit` 通过。

## 完成标准

- 财达 `idt:sync` 后，`/credit/amount/finance` 的清单里出现 `{ role: 'text', name: '全部' }`；
- 有确定名字的元素从 42 涨到约 79；
- 由此生成的 spec 能在真实宿主上跑通；
- 既有 fixture 产物逐字节不变。
