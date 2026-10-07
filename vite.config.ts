import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// 浏览器从 /scripts/extensions/third-party/ST-BaiBai-Book/dist/index.js 加载,
// 想 import 宿主 ST 的模块时需要算出从 dist/ 回到 ST public/ 根的相对路径。
// `@sillytavern/scripts/xxx` -> `../../../../../scripts/xxx.js`,并标为 external,
// 这样 ST 自身的代码不会被打进我们的包里,运行时浏览器直接走相对路径。
const relative_sillytavern_path = path.relative(
  path.join(__dirname, 'dist'),
  __dirname.substring(0, __dirname.lastIndexOf('public') + 'public'.length),
);

// ST 已在全局挂载的第三方库,映射到全局变量,避免重复打包。
const globals: Record<string, string> = {
  jquery: '$',
  lodash: '_',
  toastr: 'toastr',
};

const package_json = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as {
  version?: string;
};
const package_version = String(package_json.version ?? '');

export default defineConfig(({ mode }) => ({
  define: {
    __BBS_VERSION__: JSON.stringify(package_version),
  },

  plugins: [
    vue(),
    {
      name: 'sillytavern-resolver',
      enforce: 'pre',
      resolveId(id) {
        if (id.startsWith('@sillytavern/')) {
          return {
            id:
              path
                .join(relative_sillytavern_path, id.replace('@sillytavern/', ''))
                .replaceAll('\\', '/') + '.js',
            external: true,
          };
        }
        if (id in globals) {
          return { id, external: true };
        }
      },
    },
  ],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  test: {
    // 只跑本项目的测试:根目录的 .pnpm-store(本地虚拟商店,gitignore)里存着
    // 其它 workspace 项目的源码,默认 glob 会扫进去产生无关失败。
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', '.pnpm-store/**'],
  },

  build: {
    rollupOptions: {
      input: 'src/index.ts',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].[hash].chunk.js',
        assetFileNames: '[name].[ext]',
        // 发布映射不携带构建机器上的依赖联接路径。
        sourcemapPathTransform(sourcePath) {
          const normalized = sourcePath.replaceAll('\\', '/');
          const marker = '/node_modules/';
          const at = normalized.lastIndexOf(marker);
          return at >= 0 ? 'node_modules/' + normalized.slice(at + marker.length) : normalized;
        },
        globals,
      },
      external: id => id in globals,
    },
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: mode === 'production' ? true : 'inline',
    minify: mode === 'production',
    target: 'esnext',
  },
}));
