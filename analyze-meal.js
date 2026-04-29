// 越壕食堂真实云端多模态识别服务
//
// 启动：
//   OPENROUTER_API_KEY=sk-or-... node server/analyze-meal.js
//
// iOS 请求本服务，本服务再带着服务端环境变量里的 OpenRouter Key 请求 OpenRouter。

import fs from "node:fs";
import http from "node:http";

loadEnvFile();

const port = Number(process.env.PORT ?? 8787);
const models = (process.env.OPENROUTER_MODELS ?? "openai/gpt-4o,openai/gpt-4o-mini")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const maxUploadBytes = 8 * 1024 * 1024;
const rateLimitWindowMs = 60 * 1000;
const rateLimitMaxRequests = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 30);
const rateLimits = new Map();
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mealName", "totalCalories", "confidence", "items", "notes"],
  properties: {
    mealName: { type: "string" },
    totalCalories: { type: "integer" },
    confidence: { type: "number" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "portion", "estimatedGrams", "calories", "confidence"],
        properties: {
          name: { type: "string" },
          portion: { type: "string" },
          estimatedGrams: {
            anyOf: [{ type: "integer" }, { type: "null" }]
          },
          calories: { type: "integer" },
          confidence: { type: "number" }
        }
      }
    },
    notes: {
      type: "array",
      items: { type: "string" }
    }
  }
};

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      return sendJSON(response, 204, {});
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJSON(response, 200, {
        ok: true,
        models
      });
    }

    if (request.method !== "POST" || url.pathname !== "/analyze-meal") {
      return sendJSON(response, 404, { error: "Not found" });
    }

    if (!checkRateLimit(request)) {
      return sendJSON(response, 429, { error: "请求过于频繁，请稍后再试" });
    }

    if (!checkAppToken(request)) {
      return sendJSON(response, 401, { error: "Unauthorized" });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return sendJSON(response, 500, { error: "OPENROUTER_API_KEY is not configured" });
    }

    const contentType = request.headers["content-type"] ?? "";
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
      ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];

    if (!boundary) {
      return sendJSON(response, 400, { error: "Missing multipart boundary" });
    }

    const body = await readRequestBody(request);
    const image = parseMultipartImage(body, boundary);
    if (!allowedImageTypes.has(image.mimeType)) {
      return sendJSON(response, 415, { error: "仅支持 JPEG、PNG 或 WebP 图片" });
    }

    const result = await analyzeMealWithOpenRouter(
      image.data.toString("base64"),
      image.mimeType,
      image.correctionHint
    );

    return sendJSON(response, 200, normalizeMealResult(result));
  } catch (error) {
    console.error(error);
    return sendJSON(response, 500, {
      error: "餐食识别暂时不可用，请稍后重试"
    });
  }
});

server.listen(port, () => {
  console.log(`越壕食堂识别服务已启动：http://127.0.0.1:${port}/analyze-meal`);
  console.log(`健康检查：http://127.0.0.1:${port}/health`);
});

function checkAppToken(request) {
  const requiredToken = process.env.APP_CLIENT_TOKEN;

  if (!requiredToken) {
    return true;
  }

  return request.headers["x-app-token"] === requiredToken;
}

function checkRateLimit(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const firstForwardedIP = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(",")[0];
  const key = firstForwardedIP?.trim() || request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = rateLimits.get(key);

  if (!current || now - current.startedAt > rateLimitWindowMs) {
    rateLimits.set(key, { count: 1, startedAt: now });
    return true;
  }

  current.count += 1;
  return current.count <= rateLimitMaxRequests;
}

function loadEnvFile() {
  const candidates = [".env", "server/.env"];
  const envPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!envPath) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function analyzeMealWithOpenRouter(imageBase64, mimeType, correctionHint) {
  let lastError;

  for (const currentModel of models) {
    try {
      return await analyzeMealWithModel(imageBase64, mimeType, correctionHint, currentModel);
    } catch (error) {
      lastError = error;
      console.error(`OpenRouter model failed: ${currentModel}`, error);
    }
  }

  throw lastError ?? new Error("No OpenRouter model configured");
}

async function analyzeMealWithModel(imageBase64, mimeType, correctionHint, currentModel) {
  const correctionText = correctionHint
    ? `用户修正信息：${correctionHint} 请根据这条修正和原图重新计算。`
    : "";

  const openRouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://127.0.0.1:8787",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Yuehao Canteen"
    },
    body: JSON.stringify({
      model: currentModel,
      temperature: 0.1,
      max_tokens: 900,
      provider: {
        require_parameters: true
      },
      messages: [
        {
          role: "system",
          content: [
            "你是越壕食堂的餐食热量识别引擎。",
            "请基于图片估算食物种类、份量、热量和置信度。",
            "所有可读文本字段必须使用简体中文，包括 mealName、items.name、items.portion 和 notes。",
            "不要输出解释，只返回符合 schema 的 JSON。"
          ].join("")
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "识别这张餐食照片。",
                "重点关注中餐混合菜、米饭面食、酱汁、油量和遮挡带来的误差，并在 notes 中说明不确定因素。",
                "请返回简体中文，不要返回英文食物名。",
                correctionText
              ].filter(Boolean).join("")
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`
              }
            }
          ]
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "meal_vision_result",
          strict: true,
          schema: responseSchema
        }
      }
    })
  });

  if (!openRouterResponse.ok) {
    const errorBody = await openRouterResponse.text();
    throw new Error(`OpenRouter request failed: ${openRouterResponse.status} ${errorBody}`);
  }

  const payload = await openRouterResponse.json();
  return parseAssistantJSON(extractChatCompletionContent(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxUploadBytes) {
        reject(new Error("Image is too large"));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function parseMultipartImage(body, boundary) {
  const boundaryText = `--${boundary}`;
  const bodyText = body.toString("binary");
  const parts = bodyText.split(boundaryText);
  let correctionHint = "";
  let image;

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }

    const headers = part.slice(0, headerEnd);

    if (headers.includes('name="correctionHint"')) {
      correctionHint = part
        .slice(headerEnd + 4)
        .replace(/\r\n--$/, "")
        .trim();
      continue;
    }

    if (headers.includes('name="image"')) {
      const mimeType = headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "image/jpeg";
      const binaryStart = bodyText.indexOf(part) + headerEnd + 4;
      const binaryEnd = bodyText.indexOf(`\r\n${boundaryText}`, binaryStart);
      const data = body.subarray(binaryStart, binaryEnd === -1 ? undefined : binaryEnd);

      if (data.length === 0) {
        throw new Error("Image field is empty");
      }

      image = { data, mimeType };
    }
  }

  if (!image) {
    throw new Error("Missing image field");
  }

  return { ...image, correctionHint };
}

function extractChatCompletionContent(payload) {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content === "string" && content.length > 0) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");

    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("Meal vision response did not include assistant content");
}

function parseAssistantJSON(content) {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return JSON.parse(fencedMatch?.[1] ?? trimmed);
}

function normalizeMealResult(result) {
  const items = Array.isArray(result.items) ? result.items : [];
  const totalFromItems = items.reduce((sum, item) => sum + clampInteger(item.calories), 0);
  const totalCalories = clampInteger(result.totalCalories || totalFromItems);

  return {
    mealName: String(result.mealName || "餐食"),
    totalCalories,
    confidence: clampConfidence(result.confidence),
    items: items.map((item) => ({
      name: String(item.name || "未知食物"),
      portion: String(item.portion || "一份"),
      estimatedGrams: Number.isInteger(item.estimatedGrams) ? item.estimatedGrams : null,
      calories: clampInteger(item.calories),
      confidence: clampConfidence(item.confidence)
    })),
    notes: Array.isArray(result.notes) ? result.notes.map(String) : []
  };
}

function clampInteger(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function clampConfidence(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function sendJSON(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
    "Content-Type": "application/json; charset=utf-8"
  });

  if (statusCode === 204) {
    response.end();
    return;
  }

  response.end(JSON.stringify(payload));
}
