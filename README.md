# 越壕食堂识别代理

iOS App 请求本服务，本服务再使用服务端环境变量 `OPENROUTER_API_KEY` 调用 OpenRouter。

## Render 环境变量

```env
OPENROUTER_API_KEY=你的 OpenRouter 新 Key
OPENROUTER_MODELS=google/gemini-2.5-pro,openai/gpt-4o,google/gemini-2.5-flash,openai/gpt-4o-mini
OPENROUTER_APP_NAME=Yuehao Canteen
RATE_LIMIT_PER_MINUTE=30
```

## 本地启动

```bash
npm install
npm start
```

健康检查：

```text
GET /health
```

餐食识别：

```text
POST /analyze-meal
multipart/form-data image=<餐食图片>
multipart/form-data correctionHint=<可选，用户修改食物名称后的校正说明>
```
