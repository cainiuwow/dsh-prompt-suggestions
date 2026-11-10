# dsh-prompt-suggestions

DeepSeek Harness（dsh）的输入预测宿主。调用方把当前输入框文本发过来，服务返回一小列下一句提示或续写。

这个进程就是宿主。它在云服务器上单独听一个 HTTP 端口，不是终端插件，也不是编辑器插件，不通过 `dsh plugin add` 装进 harness 进程。

## 假设

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 是 DeepSeek 的开源 agent harness。插件宿主正常情况下跑在 `dsh` 进程里，用 `ctx.webServer` 注册路由，预测走会话上的 `ctx.llm`，密钥由 harness 自己管。社区插件（例如 `dsh-prompt-predict`）的接口是同源的 `POST /dsh-prompt-predict/suggest`，正文只有 `sessionId`，由进程内宿主去读会话。

官方没有单独公布的「输入预测 HTTP 服务」。本仓库按这个缺口实现了一个本地端点：调用方自己把当前文本（和可选的最近几轮）POST 过来。服务不读取正在运行的 dsh 会话，也不执行斜杠命令，只返回可以放进输入框的文本。

斜杠补全只用文档里的 Web 命令面板：`/compact`、`/goal`、`/plan`、`/permission`、`/feedback`、`/export`、`/model`。参数只收录文档写明的形式：`/plan off`，以及权限预设 `read-only`、`workspace-write`、`danger-full-access`。`/goal` 后面的自由文本不会被编造。

没有 `DEEPSEEK_API_KEY` 时，结果来自固定词表，同样的输入永远得到同样的结果。设置了密钥才请求 DeepSeek 的 Chat Completions（默认模型 `deepseek-flash`，关闭 thinking）。请求失败就退回词表。仓库里没有任何密钥。

## 在云虚拟机上运行

需要 Node.js 22 或更新版本。没有额外依赖。在仓库根目录：

```bash
npm test
npm start
```

默认监听 `http://127.0.0.1:8787`。换地址或端口：

```bash
HOST=127.0.0.1 PORT=8787 npm start
```

探活：

```bash
curl -sS http://127.0.0.1:8787/health
```

空输入（下一句）和一段前缀（续写）：

```bash
curl -sS -H 'content-type: application/json' \
  -d '{"input":"","source":"fallback"}' \
  http://127.0.0.1:8787/v1/suggestions

curl -sS -H 'content-type: application/json' \
  -d '{"input":"帮我","source":"fallback"}' \
  http://127.0.0.1:8787/v1/suggestions
```

`source` 设为 `fallback` 时即使配了密钥也不会打模型，方便演示。不写 `source` 时：没有密钥就用词表，有密钥就先尝试模型。

## 请求和响应

`POST /v1/suggestions`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `input` | string | 必填。当前输入框文本，可以是 `""`。首尾空白会去掉。最长 4000 字符。 |
| `messages` | array | 可选。最近几轮 `{ "role", "content" }`，`role` 只能是 `user` 或 `assistant`。只保留最后 8 条，每条内容最多 2000 字符。空输入时用来判断语言，并按测试、计划、解释等词把对应建议提前。 |
| `limit` | number | 可选。1 到 5 的整数，默认 3。 |
| `source` | string | 可选。`fallback` 或 `model`。 |

`200` 的正文：

| 字段 | 说明 |
| --- | --- |
| `suggestions[].text` | 建议放进输入框的完整文本。 |
| `suggestions[].kind` | `next` 或 `completion`。 |
| `source` | 实际用了哪条路径：`fallback` 或 `model`。 |
| `model` | 模型名。走词表时为 `null`。 |
| `modelError` | 只有尝试过模型并失败、已经改回词表时才出现。不含密钥。 |

空输入的 `kind` 是 `next`，表示猜用户接下来会发的一整句。其他普通文本的 `kind` 是 `completion`，`text` 以去掉空白后的 `input` 开头，灰字是 `text.slice(input.length)`。以 `/` 开头时按命令名做大小写不敏感匹配，返回规范的小写命令；已经打全的命令如果还有文档中的参数，就只返回参数补全，例如 `/plan` 得到 `/plan off`。没有更多补全时 `suggestions` 是空数组，这仍然是 `200`。

模型失败也返回 `200` 和词表结果。请求不合法时返回 `4xx`，正文是 `{"error":"..."}`。正文超过 32KB 返回 `413`。

`GET /health` 里 `role` 固定为 `"host"`。`predictor` 是 `fallback`，或者当前配置的模型名。它只说明有没有密钥，不说明密钥是否可用。

没有密钥时，`{"input":""}` 的响应是：

```json
{
  "suggestions": [
    { "text": "帮我看看这个改动有没有问题", "kind": "next" },
    { "text": "先给出计划，先不要改文件", "kind": "next" },
    { "text": "帮我把失败的测试修掉", "kind": "next" }
  ],
  "source": "fallback",
  "model": null
}
```

`{"input":"帮我"}` 的响应是：

```json
{
  "suggestions": [
    { "text": "帮我看看这个改动有没有问题", "kind": "completion" },
    { "text": "帮我把失败的测试修掉", "kind": "completion" },
    { "text": "帮我，并说明原因", "kind": "completion" }
  ],
  "source": "fallback",
  "model": null
}
```

`{"input":"/p"}` 的响应是：

```json
{
  "suggestions": [
    { "text": "/plan", "kind": "completion" },
    { "text": "/permission", "kind": "completion" }
  ],
  "source": "fallback",
  "model": null
}
```

## 可选的模型

变量名是 `DEEPSEEK_API_KEY`。不要写进仓库。未设置时服务完全可用。

设置之后，服务请求：

```text
POST ${DEEPSEEK_API_BASE:-https://api.deepseek.com}/chat/completions
Authorization: Bearer ${DEEPSEEK_API_KEY}
```

模型默认 `deepseek-flash`，用 `DEEPSEEK_MODEL` 覆盖。请求体里 `thinking.type` 为 `disabled`，`temperature` 为 `0`。超时、非 2xx、或者返回的文本不能当作当前输入的续写时，都退回词表，并在 `modelError` 里给一句不含密钥的原因。

| 变量 | 默认 |
| --- | --- |
| `HOST` | `127.0.0.1` |
| `PORT` | `8787` |
| `DEEPSEEK_API_KEY` | 空 |
| `DEEPSEEK_MODEL` | `deepseek-flash` |
| `DEEPSEEK_API_BASE` | `https://api.deepseek.com` |

## English summary

This process is the DeepSeek Harness input-prediction host. It runs on the cloud VM as its own HTTP service. It is not a terminal plugin and not an editor plugin.

DeepSeek Harness plugins normally register routes on `ctx.webServer` inside the `dsh` process and read the live session. There is no published standalone prediction API, so this service defines a local one: the caller sends the current composer text. The service returns text only. It does not execute slash commands or attach to a running dsh session.

From the repo root, with Node.js 22 or newer:

```bash
npm test
npm start
```

It listens on `http://127.0.0.1:8787` unless `HOST` or `PORT` is set.

`POST /v1/suggestions` takes JSON `{"input":"...","messages":[{"role":"user","content":"..."}],"limit":3,"source":"fallback"}`. The response is `{"suggestions":[{"text":"...","kind":"next"}],"source":"fallback","model":null}`. Empty input uses `kind: "next"` (a full next prompt). Any other input uses `kind: "completion"`. For ordinary text, `text` starts with the trimmed input. Slash suggestions are canonical built-in commands and match the typed prefix without regard to case.

Leave `DEEPSEEK_API_KEY` unset to use the deterministic fallback. Set it to call `POST https://api.deepseek.com/chat/completions` with model `deepseek-flash`. Do not commit a key. If the model call fails, the same fallback list is returned.
