# 原图方框提取提示词

每次从原图重新取材，每个请求只输出一个完整目标。将下面的占位内容替换为实际观察，目标、遮挡者和透视描述要具体。完整地图可作为第二张参考；只附局部裁图时删去第二张图的说明。

## 请求前的最小计划

每个来源框先写下物件清单。每件记录：

- ID、物件名称、独立摆放用途。
- 原图路径、尺寸、裁框 `[left, top, right, bottom)`，目标在裁图内的位置。
- 包含哪些物理部件，哪些邻居必须单独输出。
- 具体可见透视特征、尺度参考、脚点及原布局前后遮挡顺序。
- 需要补全的区域、依据与不确定性。

例如床区首轮生成 `bed`、`bed-rug`、`bedside-planter` 各一次，冰箱区首轮生成
`fridge`、`terminal`、`fridge-top-planter`、`floor-planter`
各一次。示例 ID 需结合实际清单避免与已有物件重名。首轮失败的物件单独修正提示词重试。

## 逐件提取模板

```text
Extract ONE existing object from the supplied original scene crop as a complete,
independently placeable 2D game asset.

SOURCE AND TARGET
Image 1 is an unmasked crop from the original scene, including surrounding context.
[Image 2 is the full original scene, for camera, lighting and style reference only.]
The crop measures [W x H] pixels. Target: [specific object and identifying features],
located approximately at [left, top, right, bottom] in Image 1.
The rectangle identifies the object; it is not a silhouette mask.

ASSET BOUNDARY
Output only [target]. Its constituent parts are [parts that belong together].
The following are separate neighboring objects and must be absent from this output:
[explicit list, with positions so similar objects cannot be confused].
Keep all parts belonging to the target, including [thin structures / foliage / feet].

ORIGINAL CAMERA — REQUIRED
Match the source object's exact orientation, projection and perspective foreshortening.
Observed geometry: [long-edge direction and slope; visible top/front/side faces;
top-face depth relative to front; vertical edges; foot/base alignment].
Retain those visible-face proportions and edge directions. Complete the object under
this SAME camera. Do not rotate, mirror, straighten into a new view, change camera
height, convert to a standard isometric view, or expose a previously unseen back face.
Uniform scaling and translation should suffice to align the result to the source.

OCCLUSION COMPLETION
[Neighbor A] covers [specific part of target]. Restore [specific missing surfaces,
border, leg, foot or texture] by continuing [observed edges, material, pattern].
[Repeat only for actual occlusions. If there are none, state that the full visible
object should be preserved, with no structural additions.]
Restore only the target's surfaces that become visible when those neighbors are removed.
Preserve genuine structural openings. Remove shadows cast by the removed neighbors;
retain the target's own internal shading and material volume.

DESIGN AND STYLE FIDELITY
Preserve the original visible design: [colors, motifs and their locations, material,
wear, outline treatment, texture and pixel density]. Keep intact details and natural
asymmetry. Use nearby original material to complete hidden parts conservatively.
Do not redesign, beautify, add ornaments, replace textures, or invent extra components.

OUTPUT
One complete isolated target, fully inside the canvas with plain margin on all sides.
Uniform pure white #FFFFFF background, including genuine openings between object parts.
Clean separation from the background, with no floor, wall, neighboring objects,
external cast shadow, outline halo, text, labels or drawn checkerboard.
Preserve opaque light-colored material that belongs to the target.
Maintain the source object's aspect ratio and original camera.
```

白色材质与白底难以区分时，将 OUTPUT 中背景改为物件不存在的指定纯色，后续按该颜色去底。去底不能把真实浅色表面变成透明。

## 两组资产的遮挡补全要点

| 独立目标     | 输出包含                         | 排除与补全要求                                                               |
| ------------ | -------------------------------- | ---------------------------------------------------------------------------- |
| 床           | 床架、床柱、床腿、床垫与床品     | 排除地毯和盆栽；补齐植物遮住的床脚或床框，保留床原有纵向透视                 |
| 床下地毯     | 同一张地毯的完整织物、边框和流苏 | 排除床和盆栽及其投影；推断床下连续纹理与完整边框，保留地面投影和长边方向     |
| 床边盆栽     | 花盆与属于它的全部枝叶           | 排除床和地毯；补齐被遮挡的盆体，维持盆口可见深度                             |
| 冰箱         | 机身、门、把手与底部支承         | 排除终端和两个盆栽；补齐被挡住的门、机身和底部，保持原顶面与侧面比例         |
| 终端         | 屏幕、控制面板、机身与底脚       | 排除冰箱和盆栽；补齐地面植物遮住的下部，维持屏幕角度和顶面深度               |
| 顶部垂吊盆栽 | 完整花盆、冠部与属于它的垂藤     | 排除冰箱及其边线；保持枝叶向下垂落的原有方向，恢复必要盆体；记录原支承面锚点 |
| 地面盆栽     | 花盆、全部叶片与枝干             | 排除终端；补齐遮挡的盆沿和盆身，保留盆口椭圆与原始视角                       |

这里的部件与遮挡描述必须回到原图核实。隐藏花纹和结构是推断内容，特别是床下大面积地毯，不能承诺原样恢复。高处盆栽的摆放基准是原支承面，不要为了让它“落地”改变相机视角或花盆形状。

## 定向重试

始终重新附原始裁图；必要时额外附失败候选并明确标成问题参考。保留目标、相机和风格约束，只补充具体错误与修复要求，例如：

```text
The previous candidate omitted the upper-left binding of the rug.
Use the ORIGINAL scene crop as the authority. Follow the visible top and left
binding to their natural meeting point and restore the missing corner locally.
Preserve the original fringe arrangement, textile design, and camera.
```

```text
The previous candidate changed the refrigerator's top-face depth.
Match the ORIGINAL crop's visible top/front ratio and edge slopes.
Complete only the area occluded by the terminal; keep the source camera fixed.
```

不要累积互相冲突的指令。重试时重写完整请求，只有通过原图对比、深浅底检查、原尺度回拼与独立完整性检查的结果才进入标准资产制作。
