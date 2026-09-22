---
name: story-authoring
description:
  为 remaining-time 编写或修改 story JSON，包括 NPC
  对话、选项效果、剧情移动、顺序任务与并行任务。用户要求编排剧情、拆分任务前置、添加独立目标或修复任务条件时使用；负责剧本内容，不负责地图美术和引擎能力开发。
---

# Story authoring

## NPC 能力归属

可选 manifest.npcs 加载人物配置；当前主线支持
`movement`、`dialogue`、`shop`、`schedule`。Story 保留变量、交互、任务、商品目录、线索和时钟。餐饮、演出、教学仅在
`experiment/tavern-agentic` 维护，不得写入主线内容。

普通 NPC 的移动许可写 `abilities.movement:true`，交谈能力写
`abilities.dialogue:true`；Scene 按人物 ID 配置初始位置、sprite 与交互站位。运行时座位绑定属于
`activity.seatedOn`，不编辑人物基础状态或存档来编排坐姿。

## 先读实际合同

路径相对于本 Skill 目录；执行项目命令前切换到仓库根目录 `../../..`。

1. 完整阅读
   [内容合同](../../../content/README.md)、[Story 能力表](../../../content/STORY_CAPABILITIES.md) 和
   [内容包说明](../../../public/content/remaining-time/README.md)。
2. 阅读
   [manifest](../../../public/content/remaining-time/manifest.json)，确定实际加载的 story 文件。读取涉及的 scene 以核对实体 ID、位置、入口和 anchors。
3. 阅读目标 story 全文及其他 story 对相同变量、实体和任务的引用。当前可玩样例在
   `public/content/remaining-time/stories/`；`content/story.json` 是测试 fixture。

只使用当前加载器支持的字段、事实与效果。能力表中的待实现项不可以直接写成 JSON 配置。

## 内容、状态与日志的边界

- 交付的是固定版本的拆分内容包，正式入口为 manifest；实验目录的 world.json 不是编辑入口。
- scene 定义实体及初始放置，story 编排动作与任务；执行过程中均不回写源文件。
- 当前坐标、剩余路线、任务进度和变量属于引擎 state，不把试玩进度复制进故事初值。
- movable 是 scene 的实体布尔属性，省略为 false；编排 move_entity 前检查目标明确允许移动，不以人物／物件外观推断权限。缺少权限需协调场景成员。
- 修改 story 后须开启使用新内容的时间线；刷新会恢复浏览器最新自动存档。旧运行使用存档中嵌入的内容，不能替换成新剧情再声称精确续播。
- 历史由引擎统一记录；不要为各实体创建 action 历史 JSON，也不要编辑导出日志以实现剧情效果。
- 阅读
  [存档使用说明](../../../README.md#存档须知)：加载自动存档直接恢复末尾state、事件序号和请求去重缓存；播放从本档开头开始，支持前后切档、定位和从暂停处续玩。内存检查点加速本档回退。

## 编写范围

- 修改 story 的台词、选项、布尔条件、效果、任务，以及已支持的剧情移动路线。
- 新增 story 文件时更新 manifest 的 stories 清单。
- 实体定义、初始放置、地图与入口由场景成员维护；外观可用 sprite/地图 art 的 JSON 尺寸、锚点、偏移和深度，参见
  [视觉配置](../../../docs/visual-assets.md)。缺少实体或空间目标时列出所需 ID 与用途，协调场景修改。
- 缺少基础能力时给出最小需求和验收例，交给引擎开发；不要为完成内容任务自行修改后端、伪造事实名称或编造日常行为语法。

## 任务编排：先判断前置，再写 steps

先把目标分成“真正依赖前一步”和“独立目标”，不要把叙述顺序误当成前置关系。

| 目标关系           | 编写方式                | 示例                                                 |
| ------------------ | ----------------------- | ---------------------------------------------------- |
| 必须逐阶段完成     | 一个 task 的有序 steps  | 接过通行证 → 去隔壁找到老黑                          |
| 可任意顺序完成     | 多个独立 task           | 四向移动练习、E 交谈                                 |
| 互不依赖的收集目标 | 多个独立 task，各自统计 | 不同探索目标同时推进；具体物品收集须先有对应事实能力 |

语义必须牢记：

- 多个 task 同时消费事实，不互相阻塞。
- 任务顶层可写 background，description 为初始说明；steps 可分别覆盖 background/description，未写时回退任务顶层。按当前阶段已知信息编写，background 每阶段完整回顾任务起因及此前经过，description 说明当前行动，不提前透露后续人物关系、奖励或安排。面板只展示已完成及当前步骤，当前步骤的 items 视为已知；未来步骤随推进揭示。
- 需要完成后回顾的任务配置 completion:{background,description}，总结起因、经过与结果，完成后保留在面板中；未发生的可选行为不能写成已完成。未配置 completion 的旧触发型任务仍在完成后隐藏。
- 左侧提示复用获得通知：激活为“新任务”，计数增加或阶段切换为“任务更新”，完成为“任务完成”。不为提示增加剧情变量或效果，存档与回放从既有进度推导。
- 每个 task 仅当前步骤接收事实；一条事实最多推进该 task 一步。
- 当前步骤激活前的行为不追溯补算。
- 条件激活使用
  `trigger:{var:"变量ID",equals:true}`；触发前隐藏且不计数，激活后保留进度。对白和选项用
  `when:{task,step}` 限定当前阶段，避免提前操作或重复领奖。
- 顺序步骤仅约束任务进度，不自动禁止提前操作。需要锁门或禁用选项时，配置实际的选项条件／效果。
- `where` 的字段全部等值匹配；不写 collect 时累计次数，写 collect 时统计不同值。
- `items` 不只是标签，也限定可收集的值；需要逐项提示时同时编写 value 与 label。

正式样例见
[S01 调查](../../../public/content/remaining-time/stories/s01-door-tag.json)，顺序／并行任务与 NPC 路线的回归内容在
`content/fixtures/route/`。

## 对话与移动

交互按实体 ID 编排；变量、交互 key 和任务 ID 按内容包规则保持唯一。scene 的 `interactionOffsets`
可提供隔柜台等额外交互站位（相对实体当前格）；默认相邻交互保留。新增站位需协调 scene，并验收玩家实际可达、远处仍不能交谈，不能把该字段写进 story。根据玩家将看到的选项文字，核对实际 effects 是否兑现承诺。

剧情移动使用 `move_entity`
的明确四向逐格 path；需要过门时按能力表配置 via 和 arrival。核对当前位置、连续路线、门及目标 anchor。路线启动不代表到达，后续效果不等待移动结束，不能把
`choice.confirmed` 写成“NPC 已抵达”的证明。

## 柜台与服务窗口的编排流程

先读 [Scene 能力表](../../../content/SCENE_CAPABILITIES.md) 和
[房间内容包](../../../public/content/remaining-time/README.md)。碰撞格、图片尺寸与图层、`interactionOffsets`
分别决定通行、遮挡和交谈站位，不混用字段，也不为 NPC 名称写源码特判。

从实际出生点核对站位可达、允许距离内可交谈、退远后拒绝。场景的格坐标与美术的像素坐标分开处理；修改生成数据应同步源配方。开启新时间线使用新内容，未试玩不声称已验收。

## 商品与商店接入

遗物固定格位及线索见
[Story 能力表“遗物线索与固定收藏”](../../../content/STORY_CAPABILITIES.md)。遗物使用
`kind:"relic"`、可选 `slot:1`
绑定固定位置；story.clues 声明按格归档的正文与来源，NPC或物件选项用 grant_clue 授予。线索ID去重，不替代实物获取，也不自动揭示未知格的名称与效果。实际样例为 public/content/remaining-time/stories/s01-door-tag.json。

先读 [Story 能力表“商品、商店与背包”](../../../content/STORY_CAPABILITIES.md)
的完整合同和 JSON 示例。主线暂无可玩商店，交易回归使用
`tests/engine/shop.testHelpers.ts`，不依赖酒馆。

1. 在 story 顶层 `items`
   定义商品 ID、name、image、category、quality、description；图片引用已存在的 public/assets
   PNG。品质与描述只是展示，不会自动产生恢复效果。
2. 在 NPC 的 `abilities.shop`
   定义 name 与 offers，每项包含 item、buySeconds、sellSeconds、stock。NPC 必须在场景摆放且具备 dialogue 能力，并有同 ID 的 Story
   interactions 条目。NPC 文件加入 manifest.npcs，对话文件加入 manifest.stories。
3. scene 负责位置及 interactionOffsets；NPC 负责商店价格、初始店存与补货，story 负责商品目录与台词。不要把动态背包／库存写回配置，也不要把美术预览 catalog.json 当成正式内容合同。
4. 按需添加
   `abilities.shop.restock:{intervalSeconds:86400}`，表示每24小时游戏剧情时间补到 offers.stock；省略 restock 关闭补货。不要用现实时间或移动模拟时间推断补货，也不要直接改写动态店存。库存超出目标时保留，多周期跳时只补到目标一次。
5. 分段时钟配置 realSecondsPerTick、gameSecondsPerTick、idlePauseSeconds 及初值。等待和睡眠按游戏时间结算生命及补货，未完成段进度保存于 State.clock；具体范围见 Story 能力表。
6. 价格单位是生命秒数。买入不能透支；卖价可单独配置为0至买价，单笔1–99件，初始店存和运行中单种数量上限9999。当前商人没有独立资金账户，卖出会补回店存。
7. 与商人交谈后，界面按 shops 自动提供“看看商品”；`1` 查看背包，`2` 查看遗物收藏。物品可声明
   `kind:"relic"` 和可选
   `effectDescription`，获得后只进入收藏展示；效果说明不自动执行游戏规则。剧情赠送使用已实现的
   `give_item`（item、quantity），配合布尔条件和变量写入控制一次性领取；细节见 Story 能力表。买卖仍通过 buy/sell 命令。当前没有食用或购买任务事实，相关剧情需求需单独协调引擎能力。
8. 验证扣时／回款、玩家数量／店存同步变化；验证余额不足、库存不足、未持有、离开交互后拒绝；验证去重、旧交互版本、存档回放与续玩。已有背包属于 State.commerce，自动存档会保留它；刷新从最新存档结尾继续。

## 座椅与坐下交互

座椅能力由 scene 的 entities[].seat 提供，先完整阅读
[Scene 能力表“可坐座椅”](../../../content/SCENE_CAPABILITIES.md)
的字段、导出及验收说明。该属性包含 orientation、depth、playerSprite；不根据 stool 等图片名称猜测能力。

- 固定座椅可以位于家具阻挡格，但不可移动、不可过门、不可同时作为商人。需要新增或调整座椅时协调 scene／美术；生成的场景需修改对应源配方后重新导出。
- 座椅使用内置 interact 坐下、stand 起身，不能给同一个座椅写 story.interactions，也不要编造 sit/stand
  choice
  effects。坐下会产生 interaction.started，可用 where.entityId 统计指定椅子或 collect.entityId 编排多椅目标；起身没有新增任务事实。
- State.seated、玩家坐标、朝向与起身位置保留属于运行状态，不写入 scene/story 初值。坐着时不能移动或交谈，起身返回来时的格子；不会自动推进时间或扣生命。
- 座椅的 `seat.table` 可将同场景多把椅子归为一桌；固定坐客在 scene 上用 `seatedOn`
  绑定座椅，position 与椅子相同，sprite 提供坐姿。每椅最多一人，客人不可移动或过门；客人的台词仍可写 story.interactions。任意客人存在时，整桌含空凳都禁止玩家坐下，验收单人桌的空座也受保护。
- 验收真实出生点可走到椅旁、坐姿与凳面匹配、E／图片／按钮都可用、起身位置不被 NPC 抢占、坐下后的存档可回放续玩并起身。当前支持玩家入座和 NPC 初始固定坐姿，不编造 NPC 离席、换座或搬运椅子行为。

## NPC 每日作息

`NPC.abilities.schedule`
配置 sleepAt、wakeAt（一天内游戏秒数）、scene、entrance、home。普通 NPC 须允许移动，休息时结束交谈并离场，返回检查路线和占位；只支持同场景出入，不编排跨场景作息。状态随存档和回放保留。

## 住宿与睡眠

当前示例为 `public/content/remaining-time/stories/unit-404.json` 的床铺交互。

已支持
`{"op":"sleep","selectHours":true}`：与等待共用1–24小时滑条，默认睡8小时；确认的 choose 命令携带 hours（1–24整数），引擎重新校验选项、床边交互、版本和余额。普通选择或固定睡眠不能携带 hours。

旧形式 `{"op":"sleep","seconds":28800}` 或 `{"op":"sleep","nextDayAt":57600}`
仍保留固定确认，seconds为1–86400，nextDayAt为0–86399且指次日时刻。三种形式互斥，必须是选项的唯一效果。前端显示醒来时刻、含段内积累的生命消耗和余额；执行复用原子等待结算。当前暂住免房费，不编造恢复效果或额外租金。完整语义见Story能力表。

## 验证与交付

在仓库根目录执行：

```sh
npm run test:prototype
npx tsc --noEmit
```

测试必须覆盖修改后的实际内容包；若仅已有测试通过，不宣称新增剧情行为已获验证。重要条件或顺序变化，为实际内容补一个最小可运行检查。

运行 `just dev`，浏览器验收：

- 先完成独立任务 B，再做 A，二者正常记录。
- 提前触发顺序任务的后续行为，不能跳过当前步骤；激活后重新触发可完成。
- 同一事实可同时推进相关的独立任务。
- 拒绝、取消、重复请求不多计；T 面板能看清进度及待做事项。
- 剧情条件确实限制需要限制的操作，移动路线与交互位置可达。

需要检查实际输入的回放时，可在设置 → 存档中选择“播放存档”；这不代替剧情可达性检查，也不证明所有分支或未来 Agent 都确定性。

无法浏览器验收时明确标为待验收。交付列出修改文件、编排关系、测试结果和所需场景／引擎协作，不将规划能力写成已实现。
