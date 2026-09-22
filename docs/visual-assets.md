# JSON 图片、锚点与图层

场景静态图层 `map.art[]` 和实体的 `sprite` 共用同一套图片配置，由 `AssetSprite` 统一渲染。

| 字段   | 含义                       | 默认／限制                                         |
| ------ | -------------------------- | -------------------------------------------------- |
| image  | public 下的本地 PNG 路径   | `assets/<目录>/<文件>.png`，小写字母、数字、短横线 |
| size   | 显示宽高，单位像素         | 省略使用原 PNG 尺寸；整数1–2048                    |
| anchor | 归一化锚点                 | 默认 `[0,0]` 左上；`[0.5,1]` 底部中心；各值0–1     |
| offset | 锚点相对逻辑位置的像素偏移 | 默认 `[0,0]`；整数 -2048–2048                      |

`左上角 = position + offset - anchor × 显示尺寸`。视觉缩放、锚点与偏移不改变通行占地。

## 静态摆放

以下是静态图层的坐标示意，图片需自行提供：

```json
{
  "image": "assets/example/counter.png",
  "position": [656, 221],
  "size": [352, 48],
  "anchor": [0.5, 1],
  "depth": 221
}
```

得到左上角 `[480,173]`，高度48px；PNG原始96px高度保留。厨具配置 `offset:[0,4]` 和
`depth:222`，绘制在台面上。 `depth`
是全场景的排序值，越大越靠前；它不是图片高度。人物使用脚底 y 排序，静态物件通常取落地边缘的 y。图层的
`position`
是图内整数像素坐标；可用 offset 作小范围偏移。图层依次为独立图片，不自动附着到另一个物体。

## 新实体外观

新增物件不必往 TypeScript 添加名称枚举，可使用 `character:"sprite"`：

```json
{
  "id": "display.pot",
  "name": "汤锅",
  "position": [10, 10],
  "character": "sprite",
  "sprite": {
    "image": "assets/example/pot.png",
    "size": [32, 32],
    "anchor": [0.5, 1],
    "offset": [16, 32]
  }
}
```

实体 position 为格坐标，渲染先乘32，再应用 sprite 偏移。该示例将锅的底部中心放在格底中央。实体图像跟随其运行位置；深度取实体格底。是否移动由 movable 决定，对话由 story 定义。当前实体仍占一格；图片放大不会自动变成多格碰撞。`sprite`
也可覆盖已有外观，带此字段的 portal 使用该图片。

房间地图与物件的生成入口见[房间内容包](../public/content/remaining-time/README.md)。图片摆放、格占地和
`interactionOffsets`
分别控制显示、通行和交谈距离；调整其中一项不能替代其他两项。PNG 不嵌入运行日志，回放外观依赖同版本资产文件。
