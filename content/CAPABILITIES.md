# 内容编写能力索引

先读
[世界数据模型 · 2026-09-15](https://afterglow.xnnehang.top/architecture/world-model-2026-09-15)：世界定义、运行状态，以及记录、持久化与恢复的职责和实际数据流。

| 编写角色 / 后续 Skill | 可修改内容                                           | 必读能力表                                     |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| Scene authoring       | `scenes/*.json`：空间、实体放置、anchors、传送目的地 | [SCENE_CAPABILITIES.md](SCENE_CAPABILITIES.md) |
| Story authoring       | `story.json`：台词、条件、效果、任务和事实统计       | [STORY_CAPABILITIES.md](STORY_CAPABILITIES.md) |

实际可玩内容位于
[`public/content/remaining-time/`](../public/content/remaining-time/README.md)：manifest 加载 scene/story 清单；scene 内定义实体及初始放置，story 按实体 ID 定义剧情。`content/scenes`
与 `content/story.json` 用于直接加载器测试，`content/fixtures/route/`
用于拆分内容的对话、NPC 路线及跨场景回归。当前浏览器加载 26 房间及 S01 调查；餐饮、演出、教学不属于主线能力。

## 常见空间问题的能力入口

| 问题                   | 通用能力与配置入口                                                                                            | 详细合同                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 家具图片提前挡住人物   | 房间配方与物件占地 → 重新导出 → scene 的格碰撞                                                                | [Scene 能力表：柜台、服务窗口](SCENE_CAPABILITIES.md)                                         |
| 柜台遮住过多身体       | 导出配方的显示尺寸、位置、锚点与深度；与地面占地分别核对                                                      | [视觉配置](../docs/visual-assets.md)                                                          |
| 隔柜台无法交谈         | scene 实体 `interactionOffsets`：相对实体当前格的额外许可站位 → 加载新内容                                    | [Scene 能力表：柜台、服务窗口](SCENE_CAPABILITIES.md)                                         |
| 固定座椅坐下／起身     | scene 实体的 seat：朝向、深度、坐姿图片；State.seated 保存占用与保留的起身位置                                | [Scene 能力表：可坐座椅](SCENE_CAPABILITIES.md)                                               |
| 固定坐客与整桌占用     | scene 客人 seatedOn 绑定座椅，seat.table 关联同桌；State.entities 保留绑定，整桌拒绝玩家入座                  | [Scene 能力表：固定坐客](SCENE_CAPABILITIES.md)                                               |
| 商品与商人买卖         | story 的 items / shops：目录、秒价、初始店存与可选游戏时间补货；背包、动态店存及下次补货时刻在 State.commerce | [Story 能力表：商品、商店与背包](STORY_CAPABILITIES.md)                                       |
| 如何把这些配置接入剧情 | 职责划分、坐标核对、导出与刷新、实际站位验收                                                                  | [Story authoring Skill：柜台与服务窗口的编排流程](../.agents/skills/story-authoring/SKILL.md) |

两者共享实体/场景 ID 与 anchor 约定，读取彼此引用并联合校验，但不修改对方职责范围或引擎源码。事实产生、统计执行、移动与碰撞等底层能力由引擎提供。

本目录保存实际能力合同。[Story authoring Skill](../.agents/skills/story-authoring/SKILL.md)
提供编剧操作流程与顺序／并行任务编排规则，并引用 Story 能力表。Scene authoring
Skill 待建立。通用加载与执行规则见 [README.md](README.md)。
