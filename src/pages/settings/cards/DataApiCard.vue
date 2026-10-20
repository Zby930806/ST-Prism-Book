<script setup lang="ts">
/* 获取数据：宏速查 + 公共接口文档导出，供其他插件和提示词读取棱镜宝书的记忆。 */
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import IconButton from '@/components/IconButton.vue';
import { toast } from '@/st/toast';
import { versionedAssetUrl } from '@/version';

const DATA_MACROS = [
  {
    token: '{{bbsInjectedHistory}}',
    title: '正常注入历史',
    desc: '与正文注入的历史相同，不含仍以全文发送的楼层的摘要。',
  },
  {
    token: '{{bbsHistory}}',
    title: '全部压缩历史',
    desc: '当前聊天全部有效的摘要和总结，含仍以全文发送的楼层。',
  },
  {
    token: '{{bbsVars}}',
    title: '全部变量',
    desc: '当前自定义变量树，紧凑 JSON 格式。',
  },
  {
    token: '{{bbsVar::路径}}',
    title: '单个变量',
    desc: '按路径读取变量，如 {{bbsVar::关系.爱丽丝.好感度}}。需使用酒馆新版宏引擎。',
  },
] as const;

async function copyDataMacro(token: string) {
  try {
    await navigator.clipboard.writeText(token);
    toast(`已复制 ${token}`, 'success');
  } catch {
    toast('复制失败，请手动选中宏文本复制。', 'error');
  }
}

function exportPublicApiDocument() {
  const anchor = document.createElement('a');
  // 运行时相对打包后的 dist/index.js 解析（与源文件所在目录无关），指向仓库根目录的 PUBLIC_API.md。
  anchor.href = versionedAssetUrl('../PUBLIC_API.md', import.meta.url);
  anchor.download = 'ST-Prism-Book-PUBLIC_API.md';
  anchor.click();
  toast('公共接口文档已导出', 'success');
}
</script>

<template>
  <Collapsible class="prism-settings-card" title="获取数据" :open="false">
    <p class="bbs-field-hint bbs-data-intro">
      以下宏可用于提示词、变量说明和其他支持酒馆宏的位置。完整的接口、命令和返回结构可导出为文档，供插件作者参考。
    </p>

    <div class="bbs-data-macros">
      <div v-for="macro in DATA_MACROS" :key="macro.token" class="bbs-data-macro">
        <div class="bbs-data-macro-main">
          <div class="bbs-data-macro-head">
            <span class="bbs-data-macro-title">{{ macro.title }}</span>
            <code class="bbs-data-token">{{ macro.token }}</code>
          </div>
          <p class="bbs-data-desc">{{ macro.desc }}</p>
        </div>
        <IconButton icon="copy" class="bbs-data-copy" :label="`复制 ${macro.token}`" @click="copyDataMacro(macro.token)" />
      </div>
    </div>

    <div class="bbs-data-export">
      <div class="bbs-data-export-text">
        <span class="bbs-field-label">公共接口文档</span>
        <p class="bbs-data-desc">下载 PUBLIC_API.md，包含 JavaScript API、斜杠命令、宏、返回结构和示例。</p>
      </div>
      <button class="bbs-btn bbs-btn-primary" type="button" @click="exportPublicApiDocument">
        <Icon name="download" />
        导出文档
      </button>
    </div>
  </Collapsible>
</template>

<style scoped>
/* 获取数据:宏速查列表 + 文档导出 */
.bbs-data-intro {
  margin-bottom: 10px;
}
.bbs-data-macros {
  border-top: 1px solid var(--bbs-line);
}
.bbs-data-macro {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--bbs-line);
}
.bbs-data-macro-main {
  flex: 1 1 auto;
  min-width: 0;
}
.bbs-data-macro-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.bbs-data-macro-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-ink);
}
.bbs-data-token {
  max-width: 100%;
  color: var(--bbs-accent);
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.bbs-data-desc {
  margin: 4px 0 0;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  line-height: 1.55;
}
.bbs-data-copy {
  flex: 0 0 auto;
}
.bbs-data-export {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 16px;
}
.bbs-data-export-text {
  flex: 1 1 auto;
  min-width: 0;
}
@media (max-width: 640px) {
  .bbs-data-export {
    align-items: stretch;
    flex-direction: column;
  }
  .bbs-data-export .bbs-btn {
    justify-content: center;
    width: 100%;
  }
}
</style>
