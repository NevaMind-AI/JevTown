# image-2 调用脚本与跨设备配置

共享入口是 [scripts/generate.py](../scripts/generate.py)，Python 3.9+ 标准库即可运行。由此前
`art/map-study/<房间>/generate_background.py` 和 `atomic-redraw/<物件>/generate.py`
整理，物件与背景沿用同一调用流程：

- 向服务的 `baseUrl + /responses` 发 POST，读取 SSE 流。
- 请求模型默认 `gpt-6-astra`；`image_generation` 工具的模型为
  `gpt-image-2`，尺寸 1024×1024、high、opaque、PNG。
- 发送本地 PNG 与已填写的提示词，可追加完整房间 PNG 作参考；每次取一个候选。
- `store:false` 是请求参数，不代表服务商的全部数据保留政策。

这是原服务使用的 Responses 工具调用方式。新设备的服务须支持上述工具与模型；仅提供
`/images/generations` 的服务不能直接使用此脚本。请求模型可通过 `--request-model`
改为该服务实际支持的模型，图像工具仍为 `gpt-image-2`。

## 配置服务

默认从 `~/.pi/agent/models.json` 读取；设置了 `PI_CODING_AGENT_DIR` 时从该目录读取，也可传
`--config /path/to/models.json`。找到列有 `gpt-image-2` 的 provider，读取其 `baseUrl` 与
`apiKey`。有多个匹配时，使用 `--provider 名称` 指定。

[image-provider.example.json](image-provider.example.json)
是可共享示例，地址为占位值，key 为环境变量引用。将其中的 provider 合并到新设备自己的
`models.json`，填写真实服务地址；已有配置不必覆盖。

在运行 Python 的进程环境中设置 `IMAGE_API_KEY`，示例引用为 `"apiKey":"$IMAGE_API_KEY"`；也支持
`"${IMAGE_API_KEY}"`。凭据通过本地密码管理器或私密渠道配置，不写入仓库。脚本兼容本地 `apiKey`
字面值和旧脚本的裸环境变量名解析，但不执行 `!command`、不读取
`auth.json`，不实现复杂字符串插值或自定义认证头。

真实 `models.json`
可能直接含 key，不能作为迁移附件提交。只分享本示例；真实 key 由使用者在新设备私下配置。

## 逐件生成

在仓库根目录执行。先在被 Git 忽略的制作目录中准备 `source-crop.png` 和 `prompt.txt`，提示词按
[提取模板](extraction-prompts.md) 填写，保留原图上下文与透视说明。

```sh
python .agents/skills/map-asset-extraction/scripts/generate.py art/map-study/unit-404/bed-candidate
```

同时附整张房间图作为第二张参考：

```sh
python .agents/skills/map-asset-extraction/scripts/generate.py art/map-study/unit-404/bed-candidate --reference art/props/unit-404/room-layout.png
```

背景补绘使用同一脚本，显式选择原图与背景提示词：

```sh
python .agents/skills/map-asset-extraction/scripts/generate.py art/map-study/unit-404/background-candidate --source art/props/unit-404/room-layout.png --prompt art/map-study/unit-404/background-candidate/background-prompt.txt
```

`--source`、`--reference` 和 `--prompt` 的显式相对路径按当前工作目录解析；`--reference`
可重复。默认输入文件位于指定候选目录。所有输入图片均须为 PNG。

输出为候选目录中的 `generated.png` 和 `generation-status.json`；已有 `generated.png`
时拒绝覆盖，重试使用新的候选目录。失败只记录异常类型，不打印 key、请求头、配置内容或服务响应正文。重定向会被拒绝，以免把认证头转发给其他端点。

生成是付费网络请求；脚本不会自动重试。候选仍需按 Skill 去底、校准尺度、核对遮挡补全和原透视，验收后再整理正式资产。

## 离线检查

```sh
python .agents/skills/map-asset-extraction/scripts/check_generate.py
```

该检查使用临时配置、测试凭据和模拟响应，验证环境变量解析、图片输出、拒绝覆盖及错误信息脱敏，不连接服务、不读取真实 pi 配置，也不证明新设备的服务已可用。
