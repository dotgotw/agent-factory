#!/usr/bin/env node
/**
 * scripts/sync-agents.mjs
 * 
 * 從 scripts/scope.json 自動同步角色權限與可寫路徑到 AGENTS.md（及各 Agent 說明文件）
 * 解決手寫文件與設定檔漂移（Drift）的問題。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');

const scopePath = join(here, 'scope.json');
const agentsMdPath = join(rootDir, 'AGENTS.md');

const START_MARKER = '<!-- AGENT-FACTORY:START -->';
const END_MARKER = '<!-- AGENT-FACTORY:END -->';

// 1. 讀取 scope.json
let config;
try {
  config = JSON.parse(readFileSync(scopePath, 'utf8'));
} catch (err) {
  console.error(`❌ 無法讀取或解析 ${scopePath}:`, err.message);
  process.exit(1);
}

// 2. 根據 scope.json 生成 Markdown 內容
function generateRolesMarkdown(scopeConfig) {
  const rows = [];
  rows.push('| 角色 | 可寫路徑 | 說明 |');
  rows.push('|---|---|---|');

  for (const [role, info] of Object.entries(scopeConfig.roles)) {
    const formattedPaths = info.allow.map(p => `\`${p}\``).join('、');
    const note = info.note || '';
    rows.push(`| ${role} | ${formattedPaths} | ${note} |`);
  }

  const everyonePaths = (scopeConfig._everyone || []).map(p => `\`${p}\``).join('、');
  let result = rows.join('\n');
  if (everyonePaths) {
    result += `\n\n所有角色皆可寫 ${everyonePaths}。`;
  }
  return result;
}

// 3. 替換 Markdown 檔案中的 Marker 區塊
function syncFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.warn(`⚠️ 找不到檔案: ${filePath}，略過。`);
    return;
  }

  const startIndex = content.indexOf(START_MARKER);
  const endIndex = content.indexOf(END_MARKER);

  if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
    console.error(`❌ 檔案 ${filePath} 中找不到成對的 ${START_MARKER} 和 ${END_MARKER}`);
    process.exit(1);
  }

  const generatedSection = generateRolesMarkdown(config);
  const newContent = 
    content.slice(0, startIndex + START_MARKER.length) +
    '\n' + generatedSection + '\n' +
    content.slice(endIndex);

  if (content === newContent) {
    console.log(`✅ ${filePath} 已是最新狀態，無需更新。`);
  } else {
    writeFileSync(filePath, newContent, 'utf8');
    console.log(`✨ 成功同步 ${filePath}（已從 scope.json 重新生成）`);
  }
}

// 執行同步
syncFile(agentsMdPath);
