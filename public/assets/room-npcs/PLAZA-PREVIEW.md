# 广场四向角色试放

Alice、Alex、Bob、Lucky、Pete、Kurt、莉奈、老板娘与 Player 展示角色放在 low-deck，通过交互启动各自的小圈路线。Player 展示不替换可操控玩家。其他角色 displayScale 为 0.35，广场帧显示大小为 45×72；Player 按游戏内对比调为 0.4、51×82，补偿其人物体量偏小的问题。脚点沿用各自图集。所有原始四向动画和时序保留，只补运行时 idle/talk/duty-1/duty-2 必需别名。

## 资产来源

- Alice、Alex、Bob、Lucky、Pete、Kurt：remaining-time 提交 `a837415738deca0c7b92e1686793dc41772ac063` 的 `art/props/<角色>-preview/`。
- 老板娘：同提交的 `public/assets/room-npcs/hostess-preview.*`。
- 莉奈：`42b11aee59cb651a2926dbb319d7a377478005b7` 的 `art/props/rinai-preview/`，使用图集已与最新预览同步的版本。
- Player：`2a25f4f7582d7594b1b2b7f711adf5a5816aca81` 的 `art/props/player-preview/`。

每套 PNG 和首帧直接取自对应版本，未重绘或改色。原始造型依据、制作记录及许可边界见上述提交中的各角色 README；AI 重绘不免除原素材许可义务。角色仍属试放候选，尤其 Bob 侧向步态仍待游戏内验收。

场景来源为 `art/room-npcs.json`，走圈交互为内容包的 `stories/alice-preview.json` 与 `stories/plaza-preview.json`。内容变更后开启新时间线；未进行本轮浏览器试玩。
