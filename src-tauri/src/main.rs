// Prevents an extra console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

use serde_json::Value as JsonValue;
use tauri_plugin_http::reqwest;

/// 确保数据目录存在（%USERPROFILE%/MirrorFin），返回数据库文件完整路径。
/// 设计决策：数据放用户目录下专属文件夹，重装软件不丢数据。
#[tauri::command]
fn ensure_db_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let dir = home.join("MirrorFin");
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let db = dir.join("mirrorfin.db");
    // 预创建空文件，避免 sqlite 连接串因缺文件而失败
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&db)
        .map_err(|e| format!("创建数据库文件失败: {e}"))?;
    Ok(db.to_string_lossy().replace('\\', "/"))
}

/// 手动备份：把数据库文件复制到用户选择的目录。
/// 调用方（前端）负责经 dialog 选目录并拼好含日期的目标文件名。
#[tauri::command]
fn export_backup(dest_path: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let src = home.join("MirrorFin").join("mirrorfin.db");
    if !src.exists() {
        return Err("数据库文件不存在".to_string());
    }
    fs::copy(&src, &dest_path).map_err(|e| format!("备份失败: {e}"))?;
    Ok(dest_path)
}

/// AI 配置文件的本地路径：%USERPROFILE%/MirrorFin/ai_config.json
fn ai_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok(home.join("MirrorFin").join("ai_config.json"))
}

/// 保存 AI 配置（Base URL / API Key / Model）。Key 仅在此写入，分析时由本进程自读。
#[tauri::command]
fn save_ai_config(base_url: String, api_key: String, model: String) -> Result<(), String> {
    let path = ai_config_path()?;
    let data = serde_json::json!({
        "base_url": base_url,
        "api_key": api_key,
        "model": model,
    });
    let s = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&path, s).map_err(|e| format!("写入 AI 配置失败: {e}"))?;
    Ok(())
}

/// 是否已配置 API Key（供前端判断先弹设置还是直接分析）。
#[tauri::command]
fn ai_configured() -> Result<bool, String> {
    let path = ai_config_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: JsonValue = serde_json::from_str(&s).unwrap_or(JsonValue::Null);
    let key = v.get("api_key").and_then(|x| x.as_str()).unwrap_or("");
    Ok(!key.trim().is_empty())
}

/// 读取已保存的 AI 配置，回填设置弹窗（配置全在本机文件，无安全顾虑）。
#[tauri::command]
fn load_ai_config() -> Result<JsonValue, String> {
    let path = ai_config_path()?;
    if !path.exists() {
        return Ok(serde_json::json!({
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "",
            "model": "deepseek-chat"
        }));
    }
    let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: JsonValue = serde_json::from_str(&s).unwrap_or(JsonValue::Null);
    Ok(v)
}

/// AI 最近一次复盘报告的本地路径：%USERPROFILE%/MirrorFin/ai_last_report.json
fn ai_report_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok(home.join("MirrorFin").join("ai_last_report.json"))
}

/// Agent 模式的 AI 调用：前端编排完整 messages（含 system）与 tools，
/// 本函数只做一次非流式请求并原样返回响应体（含 tool_calls / reasoning_content）。
/// 工具执行、循环控制、JSON 解析全部在前端（TS）完成——数据层本来就在 TS 侧，
/// Rust 只当 HTTP 中转，避免数据访问双份实现。
///
/// 【绝不设 max_tokens】2026-09-04 事故：deepseek-v4-pro 是推理模型，
/// 思考阶段（reasoning_content）与正文（content）共享输出额度。
/// 设上限会导致思考烧光额度、finish_reason=length、正文 0 字。
/// 不设则用服务商默认值（足够大），思考+正文都放得下。
#[tauri::command]
async fn ask_ai_agent(messages: String, tools: String) -> Result<JsonValue, String> {
    let path = ai_config_path()?;
    let cfg: JsonValue = if path.exists() {
        let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).unwrap_or(JsonValue::Null)
    } else {
        JsonValue::Null
    };
    let base_url = cfg
        .get("base_url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let api_key = cfg
        .get("api_key")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let model = cfg
        .get("model")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    if api_key.trim().is_empty() {
        return Err("__CONFIG_ERROR__".to_string());
    }

    // 归一化 endpoint：兼容 ".../v1"、裸域名、".../chat/completions" 三种写法
    let base = base_url.trim_end_matches('/');
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{}/chat/completions", base)
    } else {
        format!("{}/v1/chat/completions", base)
    };

    let messages: JsonValue = serde_json::from_str(&messages)
        .map_err(|e| format!("messages 不是合法 JSON: {e}"))?;
    let tools: JsonValue = serde_json::from_str(&tools)
        .map_err(|e| format!("tools 不是合法 JSON: {e}"))?;

    // temperature：财务分析要严谨、不要发散。0.3 保留一点措辞灵活性但结论稳定。
    let mut body = serde_json::json!({
        "model": model,
        "stream": false,
        "temperature": 0.3,
        "messages": messages,
    });
    // tools 为空数组时不要传该字段（部分服务商对空 tools 报错）
    if tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        body["tools"] = tools;
        body["tool_choice"] = serde_json::json!("auto");
    }

    // 超时保护：推理模型每个思考轮 60-120 秒是常态。connect 15s / 总 300s。
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {txt}"));
    }

    let v: JsonValue = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))?;
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(msg.to_string());
    }
    Ok(v)
}

/// 保存最近一次复盘（报告 + 追问对话）envelope 到本地文件。
/// 内容由前端组装（报告 JSON、视角、日期、聊天记录），本函数只负责落盘。
#[tauri::command]
fn save_ai_report(envelope: JsonValue) -> Result<(), String> {
    let path = ai_report_path()?;
    let s = serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;
    fs::write(&path, s).map_err(|e| format!("写入报告失败: {e}"))?;
    Ok(())
}

/// AI 复盘历史的本地路径：%USERPROFILE%/MirrorFin/ai_history.json
fn ai_history_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok(home.join("MirrorFin").join("ai_history.json"))
}

/// 追加写入复盘历史（跨报告的「记忆」：日期/视角/结论/建议清单）。
/// 数组内容由前端维护（只保留最近 N 条），本函数只负责落盘。
#[tauri::command]
fn save_ai_history(payload: JsonValue) -> Result<(), String> {
    let path = ai_history_path()?;
    let s = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&path, s).map_err(|e| format!("写入复盘历史失败: {e}"))?;
    Ok(())
}

/// 读取复盘历史；文件不存在或损坏返回空数组。
#[tauri::command]
fn load_ai_history() -> Result<JsonValue, String> {
    let path = ai_history_path()?;
    if !path.exists() {
        return Ok(serde_json::json!([]));
    }
    let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: JsonValue = serde_json::from_str(&s).unwrap_or(serde_json::json!([]));
    Ok(v)
}

/// 读取最近一次复盘报告 envelope；文件不存在返回 Null（前端按无报告处理）。
#[tauri::command]
fn load_ai_report() -> Result<JsonValue, String> {
    let path = ai_report_path()?;
    if !path.exists() {
        return Ok(JsonValue::Null);
    }
    let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: JsonValue = serde_json::from_str(&s).unwrap_or(JsonValue::Null);
    Ok(v)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ensure_db_dir,
            export_backup,
            save_ai_config,
            ai_configured,
            load_ai_config,
            ask_ai_agent,
            save_ai_report,
            load_ai_report,
            save_ai_history,
            load_ai_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running MirrorFin");
}
