// Prevents an extra console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

use futures_util::StreamExt;
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

/// 从 LLM 输出里提取 JSON 对象。
/// 兼容三种情况：裸 JSON、```json 代码块包裹、JSON 前后带散文。
/// 取首个 `{` 到末个 `}` 之间的子串再解析，失败返回 None。
fn extract_json(text: &str) -> Option<JsonValue> {
    let t = text.trim();
    // 去掉 ```json ... ``` 或 ``` ... ``` 围栏
    let t = if t.starts_with("```") {
        let inner = t
            .trim_start_matches("```json")
            .trim_start_matches("```");
        inner.trim_end_matches("```").trim()
    } else {
        t
    };
    if let Ok(v) = serde_json::from_str::<JsonValue>(t) {
        if v.is_object() {
            return Some(v);
        }
    }
    if let (Some(start), Some(end)) = (t.find('{'), t.rfind('}')) {
        if end > start {
            if let Ok(v) = serde_json::from_str::<JsonValue>(&t[start..=end]) {
                if v.is_object() {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// 调用用户自带的 OpenAI 兼容接口，做理财顾问分析。
/// 配置从本地 ai_config.json 读取（Key 不进前端）。
/// 累积完整流式响应后解析为结构化 JSON；解析失败则回退为纯文本。
/// 返回 envelope：{ structured: bool, content: <解析后的对象 或 原始文本> }，
/// 并把 envelope 持久化到 ai_last_report.json，供下次进入页面直接回显。
#[tauri::command]
async fn ask_ai(payload: String) -> Result<JsonValue, String> {
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

    let system = include_str!("../advisor_system_prompt.md");
    // temperature：财务分析要严谨、不要发散。此前完全没设，用 API 默认 1.0，
    // 同一份数据每次跑出来的结论差异很大。0.3 保留一点措辞灵活性但结论稳定。
    // max_tokens：给足长度，避免长报告被截断成半个 JSON 导致解析失败回退纯文本。
    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "temperature": 0.3,
        "max_tokens": 4096,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": payload }
        ]
    });

    let client = reqwest::Client::new();
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

    let mut stream = resp.bytes_stream();
    // 用字节缓冲按行切分：多字节 UTF-8 字符可能跨 chunk，
    // 若对每个 chunk 直接 from_utf8_lossy 会把半个汉字解码成 U+FFFD 乱码
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();
    let mut done = false;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => return Err(format!("读取流失败: {e}")),
        };
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes).trim_end().to_string();
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data == "[DONE]" {
                    done = true;
                    break;
                }
                if let Ok(v) = serde_json::from_str::<JsonValue>(data) {
                    if let Some(err) = v.get("error") {
                        let msg = err
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("未知错误");
                        return Err(msg.to_string());
                    }
                    let content = v
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|c| c.as_str())
                        .unwrap_or("");
                    if !content.is_empty() {
                        full.push_str(content);
                    }
                }
            }
        }
        if done {
            break;
        }
    }

    let parsed = extract_json(&full);
    let envelope = match parsed {
        Some(obj) => serde_json::json!({ "structured": true, "content": obj }),
        None => serde_json::json!({ "structured": false, "content": full }),
    };
    // 持久化最近一次报告（失败不阻塞主流程，仅记录）
    if let Err(e) = save_report(&envelope) {
        eprintln!("保存报告失败: {e}");
    }
    Ok(envelope)
}

/// 保存最近一次复盘报告 envelope 到本地文件。
fn save_report(envelope: &JsonValue) -> Result<(), String> {
    let path = ai_report_path()?;
    let s = serde_json::to_string_pretty(envelope).map_err(|e| e.to_string())?;
    fs::write(&path, s).map_err(|e| format!("写入报告失败: {e}"))?;
    Ok(())
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
            ask_ai,
            load_ai_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running MirrorFin");
}
