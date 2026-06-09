const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require("crypto");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ================= 通用工具函数 =================

function stripThink(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function deriveWorkflowUrl() {
  if (process.env.DIFY_REPORT_API_URL) {
    return process.env.DIFY_REPORT_API_URL;
  }

  if (process.env.DIFY_API_URL) {
    return process.env.DIFY_API_URL.replace("/chat-messages", "/workflows/run");
  }

  return "";
}

// ================= 腾讯数智人工具函数 =================

const TVS_BASE = "https://gw.tvs.qq.com";

function reqId() {
  return crypto.randomBytes(16).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkTencentEnv() {
  const missing = [];

  if (!process.env.TENCENT_APPKEY) missing.push("TENCENT_APPKEY");
  if (!process.env.TENCENT_ACCESS_TOKEN) missing.push("TENCENT_ACCESS_TOKEN");
  if (!process.env.TENCENT_PROJECT_ID) missing.push("TENCENT_PROJECT_ID");

  if (missing.length > 0) {
    throw new Error(`缺少腾讯数智人环境变量：${missing.join(", ")}`);
  }
}

function signedTencentUrl(pathname) {
  checkTencentEnv();

  const params = {
    appkey: process.env.TENCENT_APPKEY,
    timestamp: Math.floor(Date.now() / 1000).toString(),
  };

  const signingContent = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  const signature = crypto
    .createHmac("sha256", process.env.TENCENT_ACCESS_TOKEN)
    .update(signingContent)
    .digest("base64");

  return `${TVS_BASE}${pathname}?${signingContent}&signature=${encodeURIComponent(
    signature
  )}`;
}

async function tvsPost(pathname, payload) {
  const url = signedTencentUrl(pathname);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
    },
    body: JSON.stringify({
      Header: {},
      Payload: payload,
    }),
  });

  const rawText = await response.text();

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`腾讯数智人接口未返回 JSON：${rawText.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`腾讯数智人 HTTP 错误：${response.status} ${rawText}`);
  }

  if (data?.Header?.Code !== 0) {
    throw new Error(
      `腾讯数智人接口错误：${data?.Header?.Code} ${
        data?.Header?.Message || JSON.stringify(data)
      }`
    );
  }

  return data.Payload || {};
}

// ================= Dify：正常训练对话接口 =================

app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversation_id, user = "demo-user" } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "message is required",
      });
    }

    const response = await fetch(process.env.DIFY_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.DIFY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: {},
        query: message,
        response_mode: "blocking",
        conversation_id: conversation_id || "",
        user,
      }),
    });

    const rawText = await response.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(500).json({
        error: "Dify did not return JSON",
        status: response.status,
        content_type: response.headers.get("content-type"),
        raw_preview: rawText.slice(0, 500),
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Dify API error",
        detail: data,
      });
    }

    let answer = data.answer || "";

    let parsed = null;
    try {
      parsed = JSON.parse(answer);
    } catch (e) {
      parsed = null;
    }

    let speakText = answer;
    let displayText = answer;

    if (parsed && typeof parsed === "object") {
      speakText = parsed.speak_text || parsed.display_text || answer;
      displayText = parsed.display_text || parsed.speak_text || answer;
    }

    speakText = stripThink(speakText);
    displayText = stripThink(displayText);

    res.json({
      answer,
      speak_text: speakText,
      display_text: displayText,
      conversation_id: data.conversation_id || conversation_id || "",
      raw: data,
    });
  } catch (err) {
    res.status(500).json({
      error: "server_error",
      message: err.message,
    });
  }
});

// ================= 腾讯数智人：启动会话 =================

app.post("/api/avatar/start", async (req, res) => {
  try {
    const userId = req.body.userId || `web_user_${Date.now()}`;
    const protocol = (process.env.TENCENT_PROTOCOL || "webrtc").toLowerCase();

    const created = await tvsPost(
      "/v2/ivh/sessionmanager/sessionmanagerservice/createsession",
      {
        ReqId: reqId(),
        VirtualmanProjectId: process.env.TENCENT_PROJECT_ID,
        UserId: userId,
        Protocol: protocol,
        DriverType: 1,
      }
    );

    let sessionId = created.SessionId;
    let sessionStatus = Number(created.SessionStatus ?? created.Status ?? 0);
    let playUrl =
      created.PlayStreamAddr ||
      created.PlayStreamUrl ||
      created.PlayUrl ||
      "";

    if (!sessionId) {
      throw new Error(`创建会话成功但没有返回 SessionId：${JSON.stringify(created)}`);
    }

    console.log("腾讯数智人会话创建成功：", {
      sessionId,
      sessionStatus,
      playUrl,
    });

    // 如果状态不是 1，继续轮询等待就绪
    for (let i = 0; i < 60 && sessionStatus !== 1; i++) {
      await sleep(2000);

      const stat = await tvsPost(
        "/v2/ivh/sessionmanager/sessionmanagerservice/statsession",
        {
          ReqId: reqId(),
          SessionId: sessionId,
        }
      );

      sessionStatus = Number(stat.SessionStatus ?? stat.Status ?? sessionStatus);
      playUrl =
        stat.PlayStreamAddr ||
        stat.PlayStreamUrl ||
        stat.PlayUrl ||
        playUrl;

      console.log(`腾讯数智人状态轮询 ${i + 1}/60：`, {
        sessionStatus,
        playUrl,
      });
    }

    if (sessionStatus !== 1) {
      throw new Error(`数智人会话未就绪，当前状态：${sessionStatus}`);
    }

    await tvsPost(
      "/v2/ivh/sessionmanager/sessionmanagerservice/startsession",
      {
        ReqId: reqId(),
        SessionId: sessionId,
      }
    );

    res.json({
      ok: true,
      sessionId,
      playUrl,
      sessionStatus,
      userId,
    });
  } catch (err) {
    console.error("启动腾讯数智人失败：", err);
    res.status(500).json({
      error: "avatar_start_failed",
      message: err.message,
    });
  }
});

// ================= 腾讯数智人：文本播报 =================

app.post("/api/avatar/speak", async (req, res) => {
  try {
    const { sessionId, text } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        error: "sessionId is required",
      });
    }

    if (!text || !String(text).trim()) {
      return res.status(400).json({
        error: "text is required",
      });
    }

    await tvsPost(
      "/v2/ivh/interactdriver/interactdriverservice/command",
      {
        ReqId: reqId(),
        SessionId: sessionId,
        Command: "SEND_TEXT",
        Data: {
          Text: String(text).slice(0, 3900),
          ChatCommand: "NotUseChat",
        },
      }
    );

    res.json({
      ok: true,
    });
  } catch (err) {
    console.error("腾讯数智人播报失败：", err);
    res.status(500).json({
      error: "avatar_speak_failed",
      message: err.message,
    });
  }
});

// ================= 腾讯数智人：打断播报 =================

app.post("/api/avatar/interrupt", async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        error: "sessionId is required",
      });
    }

    await tvsPost(
      "/v2/ivh/interactdriver/interactdriverservice/command",
      {
        ReqId: reqId(),
        SessionId: sessionId,
        Command: "SEND_TEXT",
        Data: {
          Interrupt: true,
        },
      }
    );

    res.json({
      ok: true,
    });
  } catch (err) {
    console.error("腾讯数智人打断失败：", err);
    res.status(500).json({
      error: "avatar_interrupt_failed",
      message: err.message,
    });
  }
});

// ================= 腾讯数智人：关闭会话 =================

app.post("/api/avatar/close", async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        error: "sessionId is required",
      });
    }

    await tvsPost(
      "/v2/ivh/sessionmanager/sessionmanagerservice/closesession",
      {
        ReqId: reqId(),
        SessionId: sessionId,
      }
    );

    res.json({
      ok: true,
    });
  } catch (err) {
    console.error("关闭腾讯数智人失败：", err);
    res.status(500).json({
      error: "avatar_close_failed",
      message: err.message,
    });
  }
});

// ================= 结束训练并生成报告接口 =================

app.post("/api/training/finish", async (req, res) => {
  try {
    const {
      trainee_name,
      traineeName,
      scenario_name,
      scenarioName,
      doctor_role,
      doctorRole,
      dialogue_log,
      dialogueLog,
      start_time,
      startTime,
      end_time,
      endTime,
      duration,
    } = req.body;

    const finalTraineeName = trainee_name || traineeName || "测试代表";
    const finalScenarioName =
      scenario_name || scenarioName || "内分泌科主任糖尿病药物拜访";
    const finalDoctorRole = doctor_role || doctorRole || "严谨型内分泌科主任";
    const finalDialogueLog = dialogue_log || dialogueLog || [];
    const finalStartTime = start_time || startTime || "";
    const finalEndTime = end_time || endTime || new Date().toISOString();
    const finalDuration = duration || "";

    if (!Array.isArray(finalDialogueLog) && typeof finalDialogueLog !== "string") {
      return res.status(400).json({
        error: "dialogue_log must be an array or string",
      });
    }

    const workflowUrl = deriveWorkflowUrl();

    if (!workflowUrl) {
      return res.status(500).json({
        error: "DIFY_REPORT_API_URL is missing",
        message:
          "请在 .env 中配置 DIFY_REPORT_API_URL，或者确保 DIFY_API_URL 包含 /chat-messages 以便自动推导 /workflows/run",
      });
    }

    if (!process.env.DIFY_REPORT_API_KEY) {
      return res.status(500).json({
        error: "DIFY_REPORT_API_KEY is missing",
        message: "请在 .env 中配置你的报告 Workflow API Key",
      });
    }

    const dialogueLogText =
      typeof finalDialogueLog === "string"
        ? finalDialogueLog
        : JSON.stringify(finalDialogueLog, null, 2);

    const response = await fetch(workflowUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.DIFY_REPORT_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: {
          trainee_name: finalTraineeName,
          scenario_name: finalScenarioName,
          doctor_role: finalDoctorRole,
          dialogue_log: dialogueLogText,
          start_time: finalStartTime,
          end_time: finalEndTime,
          duration: finalDuration,
        },
        response_mode: "blocking",
        user: finalTraineeName || "demo-user",
      }),
    });

    const rawText = await response.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return res.status(500).json({
        error: "Dify report workflow did not return JSON",
        status: response.status,
        content_type: response.headers.get("content-type"),
        raw_preview: rawText.slice(0, 1000),
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Dify report workflow API error",
        detail: data,
      });
    }

    const outputs = data.data?.outputs || data.outputs || {};

    let scoreJson =
      outputs.score_json ||
      outputs.text ||
      outputs.textString ||
      outputs.llm_output ||
      "";

    let reportHtml =
      outputs.report_html ||
      outputs.output ||
      outputs.outputString ||
      outputs.template_output ||
      "";

    if (typeof scoreJson === "string") {
      scoreJson = stripThink(scoreJson);
    }

    if (typeof reportHtml === "string") {
      reportHtml = stripThink(reportHtml);
    }

    res.json({
      score_json: scoreJson,
      report_html: reportHtml,
      raw: data,
    });
  } catch (err) {
    console.error("生成训练报告失败：", err);
    res.status(500).json({
      error: "generate_report_failed",
      message: err.message,
    });
  }
});

// ================= 启动服务器 =================

const port = process.env.PORT || 3000;

app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});