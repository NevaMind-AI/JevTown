# Scene 编写能力表 · MVP

归属：scene authoring Skill，负责
`scenes/*.json`。只列当前加载器支持的能力。剧情、任务、条件、计数与效果见
[Story 能力表](STORY_CAPABILITIES.md)。

必读：[内容合同](README.md)、[房间样例](scenes/room.json)、[走廊样例](scenes/corridor.json)。校验依据：`prototype/content.ts`；地图构造：`prototype/map.ts`。

## 可编写字段

| 位置                            | 必需 | 当前能力与限制                                                                                                                                                                                                                |
| ------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`                | 是   | 当前为 `1.0`，其他值拒绝                                                                                                                                                                                                      |
| `content_version`               | 是   | 非空内容修订标识                                                                                                                                                                                                              |
| `id` / `name`                   | 是   | 场景唯一 ID / 显示名称                                                                                                                                                                                                        |
| `map.width` / `height`          | 是   | 5–64 的整数瓦片尺寸                                                                                                                                                                                                           |
| `map.floorTile` / `wallTile`    | 是   | 内联测试地图使用 gentle 图集整数 0–1439；正式房间使用 map.source 加载 render 与 collision                                                                                                                                     |
| `map.collision`                 | 否   | height 行字符串，每行 width 个 `.`／`#`，分别可走／阻挡；提供时覆盖默认边界规则，地图外始终不可走                                                                                                                             |
| `map.blockedEdges`              | 否   | 最多100条双向通行边界，每条为相邻两格`[ax,ay,bx,by]`，整数且在图内。两格本身仍可站立，但玩家、NPC寻路与剧情移动不能跨越这条边；进入portal前同样检查。省略时无额外边界                                                         |
| `map.art`                       | 否   | 最多100项 `{image,position,depth}`；可加 size/anchor/offset；本地 PNG 路径，position 为图内整数像素坐标，depth 为 -1 至 height×32 的整数；详见 [视觉配置](../docs/visual-assets.md)                                           |
| `map.playerScale`               | 否   | 1–3 的显示倍率，默认1；美术图层模式下人物脚底对齐格中心，视觉倍率不改变碰撞网格                                                                                                                                               |
| `anchors`                       | 是   | 命名到达点：`"entrance": [2,3]`，整数瓦片坐标；必须可走且无实体占据                                                                                                                                                           |
| `entities[].id` / `name`        | 是   | 内容包内唯一实体 ID / 显示名；story 直接使用此 ID                                                                                                                                                                             |
| `entities[].position`           | 是   | 整数瓦片坐标，普通实体不可重叠，固定座椅与其一名绑定坐客可同格；普通实体须在可走格，seat 可位于地图内部的家具阻挡格                                                                                                           |
| `entities[].character`          | 是   | `f1`–`f8`、`book`、带 portal 的 `door`，或明确声明 sprite 的 `sprite`                                                                                                                                                         |
| `entities[].sprite`             | 否   | `{image,size?,anchor?,offset?}` 通用图片外观；使用 `character:"sprite"` 时必需，亦可覆盖已有外观；跟随实体位置，碰撞仍为一格                                                                                                  |
| `entities[].interactionOffsets` | 否   | 最多100个相对实体当前格的额外交互偏移 `[dx,dy]`，整数且曼哈顿距离1–4；默认相邻交互继续有效。例 `[[0,2]]` 允许玩家站在实体下方两格隔柜台交谈；显式许可不检查中间碰撞，不改变通行。portal 不支持，移动／过门中的 NPC 仍不可交谈 |
| `entities[].movable`            | 否   | 布尔值，默认 false；true 允许 story 的 move_entity，不取决于外观。当前 portal 必须保持不可移动。此属性不提供玩家搬运界面。                                                                                                    |
| `entities[].seatedOn`           | 否   | 起始坐姿绑定的座椅 ID；固定 sprite 客人须与同场景座椅同格，一椅一客；详见下节                                                                                                                                                 |
| `entities[].seat`               | 否   | `{orientation,depth,playerSprite}` 固定座椅；内置坐下／起身交互，完整字段、空间规则和示例见下节                                                                                                                               |
| `entities[].portal`             | 否   | `{ "scene": "corridor", "anchor": "entrance" }`；目标必须存在                                                                                                                                                                 |

普通实体当前占据一个阻挡格。portal 格触碰后由引擎检查 story 中同 ID 条目的条件，合法才传送。scene 声明空间目的地，不编写许可、台词、支付或任务完成条件。

## 可坐座椅

以下图片为示意路径，需自行提供素材。在 scene 的实体上声明 seat，即可让玩家从相邻格按 E、点击座椅或交互按钮坐下。坐下使用 playerSprite，按 E、点击坐姿人物／座椅或“起身”返回来时的格子。无需 story 对话或效果；不声明 seat 的普通凳子外观不会自动获得能力。

```json
{
  "id": "room.table-1-right-stool",
  "name": "1号桌右侧圆凳",
  "position": [5, 5],
  "character": "sprite",
  "sprite": {
    "image": "assets/example/stool.png",
    "size": [26, 31],
    "anchor": [0, 0],
    "offset": [-6, -9]
  },
  "seat": {
    "orientation": 180,
    "depth": 182,
    "playerSprite": {
      "image": "assets/example/player-seated.png",
      "size": [64, 64],
      "anchor": [0.5, 1],
      "offset": [7, 12]
    }
  }
}
```

| 字段／约束          | 语义                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seat.table`        | 可选非空字符串，长度及保留字规则同实体ID；同场景内相同标记表示同一桌。任意绑定客人存在时，同桌全部座椅拒绝玩家入座；省略时只保护实际被占的那一椅                     |
| `seat.orientation`  | 必填；0向右、90向下、180向左、270向上。坐下设置逻辑朝向；图片本身不自动旋转，需要选匹配姿态的 PNG                                                                    |
| `seat.depth`        | 必填整数，0至地图像素高度减1；座椅图层深度，坐姿人物在 depth+1。用于控制与桌面的遮挡                                                                                 |
| `seat.playerSprite` | 必填 Visual；与实体 sprite 一样，位置基点是实体格坐标×32，size／offset 单位像素，anchor 为0–1比例。路径、尺寸、锚点、偏移限制沿用通用 Visual 合同                    |
| 身份与位置          | character 必须是 sprite 且有 sprite；不可 movable、不可 portal，不可与 anchor 同格；只允许和一名通过 seatedOn 绑定的客人同格；位置必须在边界内部，可落在家具的阻挡格 |
| 交互                | 内置坐下动作，禁止同时配置 story.interactions 或 shops。相邻交互默认有效；interactionOffsets 仍为显式额外站位，作者需验证站位可达与空间合理                          |

示例中凳图左上角为 `[5×32-6,5×32-9]=[154,151]`；坐姿图片脚底锚点为 `[167,172]`，面朝左侧桌面。玩家从
`[6,5]` 坐下后，逻辑位置进入
`[5,5]`，但该格仍阻止普通走入。仅允许玩家通过坐下动作与这个固定座椅共享格子，不提供任意实体叠放；固定客人的初始入座见下节。

坐姿保存在可选
`State.seated={entity,returnPosition:{x,y}}`。原站位在坐着期间被保留，NPC 路线和过门到达不能占用它；起身再次检查位置，失败不部分移动。坐着不能走动或发起其他交互，须先起身。坐下／起身不会推进剧情时间、扣生命或视为走了一步；坐下会发出已有的 interaction.started 事实，可按椅子 ID 编排交互任务。当前为静态双侧坐姿，不含客人离席、搬椅子或入座动画。

运行命令为 `{requestId,type:"interact",target:座椅ID}` 与
`{requestId,type:"stand"}`；支持去重、原子记录、检查点与回放续玩。未坐下不增加 seated 字段，起身删除它，旧内容／记录保持原状态形状。

### 固定坐客与整桌占用

左右座椅的 seat.table 设为同一标记（例如 room.table-3），再在 scene 中添加绑定座椅的客人：

```json
{
  "id": "room.guest-3-left",
  "name": "独坐的客人",
  "position": [2, 9],
  "character": "sprite",
  "seatedOn": "room.table-3-left-stool",
  "sprite": {
    "image": "assets/example/guest.png",
    "size": [64, 64],
    "anchor": [0.5, 1],
    "offset": [17, -4]
  }
}
```

- seatedOn 必须指向同场景真实 seat，position 必须与座椅相同（整数格）；一个座椅最多一名客人。客人不能同时是 seat、movable 或 portal，必须提供 sprite。
- 客人可有普通 story.interactions；E 优先选择邻近客人，再选择椅子。对话不改变客人的坐向，朝向初值来自座椅；客人图片在 seat.depth+1 绘制，须自行提供匹配的坐姿图片。
- State.entities[客人ID].activity.seatedOn 保存运行中的绑定；同桌占用由此与静态 seat.table 共同判定。只为坐客增加该可选字段，旧内容状态形状不变。
- 有坐客的桌子，空着的同桌凳子也不可入座。按钮显示“此桌已有客人”，E／图片点击由同一运行时检查拒绝，不改变位置或坐姿；失败事件仍进入记录。
- 当前坐客固定在初始座位，可交谈；没有离席／换桌命令。回放、检查点与续玩保留绑定和占用规则。

## 柜台、服务窗口：碰撞与交互配置

碰撞由场景的 `map.collision` 与 `blockedEdges` 决定，显示使用 `sprite` / `map.art`
的尺寸、锚点、偏移和深度。二者分别配置，不按图片透明边界推断通行。房间占地与导出入口见[房间内容包](../public/content/remaining-time/README.md)。

### interactionOffsets：额外允许交谈的站位

这是 **scene 实体字段**。以下为示意配置，图片需要作者提供：

```json
{
  "id": "room.hostess",
  "name": "窗口职员",
  "position": [20, 5],
  "character": "sprite",
  "sprite": {
    "image": "assets/example/npc.png",
    "size": [64, 64],
    "anchor": [0.5, 1],
    "offset": [16, 16]
  },
  "interactionOffsets": [[0, 2]]
}
```

- 每项为
  `[dx,dy]`，单位是**格**，相对实体的**当前位置**：`玩家站位 = 实体位置 + 偏移`。x 向右、y 向下，方向不随人物朝向旋转。`[0,2]`
  对应实体下方两格，本例为 `[20,7]`。
- 默认四向相邻一格仍允许交互；该列表只是增加精确匹配的站位，不是半径。省略字段或使用空列表时，只有默认相邻规则。
- 最多100项，每项恰好两个整数，且 `1 <= |dx|+|dy| <= 4`。`[0,0]`、小数或超出距离上限的配置会被拒绝。
- 这是明确的跨障碍交互许可：引擎不检查两点之间的墙体或视线，也不修改碰撞。作者要确认玩家能走到该点，且隔着的确实是适合交谈的柜台或窗口。附近但不在许可点的远处站位不会自动放行。
- 实体必须有 `story.interactions[实体ID]`
  才能交谈；台词、选项和效果仍在 story。Portal 不支持该字段；玩家移动未结束、NPC 正执行路线或过门时不能开始交谈。
- E 键、点击人物、交互按钮和直接交互命令共用判定。交谈成功时更新双方逻辑朝向；固定 PNG 立姿不会自动变成四向动画。实体移动后偏移跟随当前位置，不是固定在初始柜台上的服务点。
- 修改 scene 后更新内容版本并刷新开始新局，无需运行美术导出。录制嵌入该配置；旧记录继续使用其内嵌内容，不能替换成新 scene 后声称原样回放。

## 与 Story 的协作

| Scene 提供             | Story 使用                                               | 联合验收                                                               |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| 场景 ID 与 anchors     | `story.start`、场景到达任务                              | 初始点和传送点可达                                                     |
| 实体 ID                | `story.interactions[entityId]`、任务目标                 | 引用存在且符合预期交互                                                 |
| 商人实体 ID 与交互站位 | `story.shops[entityId]` 的价格／初始店存、items 商品目录 | 与该实体交谈后出现商品入口，柜台外可买卖；scene 不存玩家背包或动态店存 |
| portal 目标与到达点    | 同实体交互中的条件及 travel 效果                         | 每个 portal 恰好一个含 travel 的选项；到达点不在门上，避免往返循环     |

两个 Skill 分别修改自己的文件，读取对方标识来校验引用。需要新增/改名实体或入口时先协调，再一起验证内容包，不能只改一边。当前加载器要求场景和剧情整体校验，scene 文件不能单独证明剧情有效。

## 当前边界

移动、碰撞算法、渲染和传送执行属于引擎，不由内容 Skill 修改源码。当前支持固定 PNG 像素图层、深度排序和独立格碰撞；NPC 自主移动、连续形状碰撞、小地图配置仍在规划中。

当前场景见[404 房间](../public/content/remaining-time/scenes/unit-404.json)。art 仅为静态美术，不自动创建实体或交互；碰撞须明确声明。PNG 必须随游戏打包，校验只检查路径形状，不证明文件存在或视觉正确。新物件使用
`character:"sprite"`，无需添加 TypeScript 物件名枚举。

调整位置、瓦片或 portal 目标不需要改 schema；扩展允许的字段/视觉能力需同步加载器、实现、本表和版本说明。内部代码重构应保持已接受内容的含义；破坏性变化升级主版本并明确迁移路径。
